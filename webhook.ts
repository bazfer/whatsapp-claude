import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { validateRequest } from "twilio";
import {
  allowWithPairingCode,
  CHANNEL_HOME,
  hasPendingPairingCode,
  isAllowlisted,
  issuePairingCode,
  normalizeWhatsAppAddress,
} from "./allowlist";
import { DEFAULT_MAX_MEDIA_BYTES, TwilioWhatsAppClient } from "./twilio-client";

const DEFAULT_MAX_ATTACHMENTS = 4;
const DEFAULT_ALLOWED_ATTACHMENT_TYPES = ["image/*", "audio/*", "video/*", "application/pdf", "text/plain"] as const;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function attachmentLimit(): number {
  return positiveIntFromEnv("WA_CHANNEL_MAX_ATTACHMENTS", DEFAULT_MAX_ATTACHMENTS);
}

function mediaByteLimit(): number {
  return positiveIntFromEnv("WA_CHANNEL_MAX_MEDIA_BYTES", DEFAULT_MAX_MEDIA_BYTES);
}

function allowedAttachmentTypes(): string[] {
  const raw = process.env.WA_CHANNEL_ALLOWED_MEDIA_TYPES;
  if (!raw) return [...DEFAULT_ALLOWED_ATTACHMENT_TYPES];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedContentType(contentType: string, allowed: readonly string[]): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowed.some((entry) => {
    if (entry.endsWith("/*")) return normalized.startsWith(entry.slice(0, -1));
    return normalized === entry;
  });
}

function parsePairCommand(text: string): string | undefined {
  const match = text.trim().match(/^pair\s+([A-Za-z0-9-]{4,64})$/i);
  return match?.[1];
}

export type InboundAttachment = {
  index: number;
  url: string;
  contentType: string;
};

export type InboundMessage = {
  chat_id: string;
  message_id: string;
  user?: string;
  text: string;
  ts: string;
  attachments: InboundAttachment[];
};

export type StoredAttachmentMessage = InboundMessage & {
  attachments: InboundAttachment[];
};

export type WebhookOptions = {
  port?: number;
  webhookUrl?: string;
  twilioAuthToken: string;
  twilioClient: TwilioWhatsAppClient;
  onMessage: (message: InboundMessage) => Promise<void> | void;
};

export type WebhookServer = ReturnType<typeof Bun.serve>;

const attachmentIndex = new Map<string, StoredAttachmentMessage>();

function publicWebhookUrl(request: Request, configured?: string): string {
  if (!configured) return request.url;
  const configuredUrl = new URL(configured);
  if (configuredUrl.pathname === "/" || configuredUrl.pathname === "") {
    const requestUrl = new URL(request.url);
    configuredUrl.pathname = requestUrl.pathname;
    configuredUrl.search = requestUrl.search;
  }
  return configuredUrl.toString();
}

async function parseForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    params[key] = String(value);
  }
  return params;
}

function validateTwilioSignature(request: Request, url: string, params: Record<string, string>, token: string): boolean {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return true;
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!signature) return false;
  return validateRequest(token, signature, url, params);
}

function attachmentsFromParams(params: Record<string, string>): InboundAttachment[] {
  const count = Number.parseInt(params.NumMedia ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) return [];

  const maxAttachments = attachmentLimit();
  if (count > maxAttachments) {
    throw new Error(`Too many attachments: ${count} exceeds limit of ${maxAttachments}`);
  }

  const allowedTypes = allowedAttachmentTypes();
  const attachments: InboundAttachment[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = params[`MediaUrl${index}`];
    if (!url) continue;
    const contentType = params[`MediaContentType${index}`] ?? "application/octet-stream";
    if (!isAllowedContentType(contentType, allowedTypes)) {
      throw new Error(`Attachment ${index} content type is not allowed: ${contentType}`);
    }
    attachments.push({
      index,
      url,
      contentType,
    });
  }
  return attachments;
}

function extensionFor(contentType: string): string {
  const subtype = contentType.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) return ".bin";
  if (subtype === "jpeg") return ".jpg";
  if (/^[a-z0-9.+-]+$/i.test(subtype)) return `.${subtype.replace("+", ".")}`;
  return ".bin";
}

export function getStoredAttachment(chatId: string, messageId: string): StoredAttachmentMessage | undefined {
  return attachmentIndex.get(`${normalizeWhatsAppAddress(chatId)}:${messageId}`);
}

export async function downloadStoredAttachment(
  twilioClient: TwilioWhatsAppClient,
  chatId: string,
  messageId: string,
): Promise<string[]> {
  const stored = getStoredAttachment(chatId, messageId);
  if (!stored || stored.attachments.length === 0) {
    throw new Error(`No attachment found for ${chatId}/${messageId}. Attachment lookup is in-memory for this process.`);
  }

  const inboxDir = join(CHANNEL_HOME, "inbox");
  await mkdir(inboxDir, { recursive: true });

  const allowedTypes = allowedAttachmentTypes();
  const saved: string[] = [];
  for (const attachment of stored.attachments) {
    const media = await twilioClient.downloadMedia(attachment.url, {
      maxBytes: mediaByteLimit(),
      allowedContentTypes: allowedTypes,
    });
    const extFromUrl = extname(new URL(attachment.url).pathname);
    const ext = extFromUrl || extensionFor(media.contentType || attachment.contentType);
    const path = join(inboxDir, `${messageId}-${attachment.index}${ext}`);
    await writeFile(path, media.bytes);
    saved.push(path);
  }
  return saved;
}

function twiml(text: string): Response {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return new Response(`<Response><Message>${escaped}</Message></Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

export function startWebhookServer(options: WebhookOptions): WebhookServer {
  const port = options.port ?? Number.parseInt(process.env.WEBHOOK_PORT ?? "3000", 10);

  return Bun.serve({
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") {
        return Response.json({ ok: true });
      }
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      const params = await parseForm(request);
      const validationUrl = publicWebhookUrl(request, options.webhookUrl ?? process.env.WEBHOOK_URL);
      if (!validateTwilioSignature(request, validationUrl, params, options.twilioAuthToken)) {
        console.error("Dropped inbound WhatsApp webhook with invalid Twilio signature");
        return new Response("forbidden", { status: 403 });
      }

      const from = normalizeWhatsAppAddress(params.From ?? "");
      if (!from) return new Response("missing From", { status: 400 });

      if (!(await isAllowlisted(from))) {
        const pairingCode = parsePairCommand(params.Body ?? "");
        if (pairingCode) {
          const paired = await allowWithPairingCode(from, pairingCode);
          const message = paired
            ? "WhatsApp pairing complete. You can now message Claude from this number."
            : "That pairing code was not valid for this WhatsApp number. Please check the code and reply with PAIR <code>.";
          try {
            await options.twilioClient.sendMessage(from, message);
          } catch (error) {
            console.error("Failed to send WhatsApp pairing result", error);
            return twiml(message);
          }
          return new Response(paired ? "paired" : "invalid pairing code", { status: 202 });
        }

        const hasPending = await hasPendingPairingCode(from);
        const message = hasPending
          ? "This WhatsApp number is not paired with Claude yet. Reply with PAIR <code> using the pairing code you received."
          : `This WhatsApp number is not paired with Claude yet. Reply with PAIR ${await issuePairingCode(from)} to pair this number.`;
        try {
          await options.twilioClient.sendMessage(from, message);
        } catch (error) {
          console.error("Failed to send WhatsApp pairing instructions", error);
          return twiml(message);
        }
        return new Response("unpaired", { status: 202 });
      }

      let attachments: InboundAttachment[];
      try {
        attachments = attachmentsFromParams(params);
      } catch (error) {
        console.error("Dropped inbound WhatsApp webhook with rejected attachment metadata", error);
        return twiml("Attachment rejected because it exceeds this channel's safety limits.");
      }

      const inbound: InboundMessage = {
        chat_id: from,
        message_id: params.MessageSid || params.SmsMessageSid || crypto.randomUUID(),
        user: params.ProfileName || params.WaId || from,
        text: params.Body ?? "",
        ts: new Date().toISOString(),
        attachments,
      };

      if (inbound.attachments.length > 0) {
        attachmentIndex.set(`${inbound.chat_id}:${inbound.message_id}`, inbound);
      }

      await options.onMessage(inbound);
      return new Response("ok", { status: 200 });
    },
  });
}
