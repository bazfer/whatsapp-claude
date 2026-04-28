import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { validateRequest } from "twilio";
import { CHANNEL_HOME, isAllowlisted, issuePairingCode, normalizeWhatsAppAddress } from "./allowlist";
import { TwilioWhatsAppClient } from "./twilio-client";

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

  const attachments: InboundAttachment[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = params[`MediaUrl${index}`];
    if (!url) continue;
    attachments.push({
      index,
      url,
      contentType: params[`MediaContentType${index}`] ?? "application/octet-stream",
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

  const saved: string[] = [];
  for (const attachment of stored.attachments) {
    const blob = await twilioClient.downloadMedia(attachment.url);
    const extFromUrl = extname(new URL(attachment.url).pathname);
    const ext = extFromUrl || extensionFor(attachment.contentType);
    const path = join(inboxDir, `${messageId}-${attachment.index}${ext}`);
    await writeFile(path, Buffer.from(await blob.arrayBuffer()));
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
        const code = await issuePairingCode(from);
        try {
          await options.twilioClient.sendMessage(
            from,
            `This WhatsApp number is not paired with Claude yet. Pairing code: ${code}. Add ${from} to ~/.claude/channels/wa-channel/access.json to allow future messages.`,
          );
        } catch (error) {
          console.error("Failed to send WhatsApp pairing code", error);
          return twiml(`Pairing code: ${code}`);
        }
        return new Response("unpaired", { status: 202 });
      }

      const inbound: InboundMessage = {
        chat_id: from,
        message_id: params.MessageSid || params.SmsMessageSid || crypto.randomUUID(),
        user: params.ProfileName || params.WaId || from,
        text: params.Body ?? "",
        ts: new Date().toISOString(),
        attachments: attachmentsFromParams(params),
      };

      if (inbound.attachments.length > 0) {
        attachmentIndex.set(`${inbound.chat_id}:${inbound.message_id}`, inbound);
      }

      await options.onMessage(inbound);
      return new Response("ok", { status: 200 });
    },
  });
}
