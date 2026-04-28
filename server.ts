import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { approveAccessRequest, isAllowlisted, listAccessRequests, normalizeWhatsAppAddress } from "./allowlist";
import { downloadStoredAttachment, startWebhookServer, type InboundMessage } from "./webhook";
import { getTwilioConfigFromEnv, TwilioWhatsAppClient } from "./twilio-client";

const ReplyArgs = z.object({
  chat_id: z.string().min(1),
  text: z.string(),
});

const DownloadAttachmentArgs = z.object({
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
});

const ApproveAccessRequestArgs = z.object({
  code: z.string().min(4).max(64),
});

const twilioConfig = getTwilioConfigFromEnv();
const twilioClient = new TwilioWhatsAppClient(twilioConfig);

const server = new Server(
  {
    name: "wa-channel",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a WhatsApp reply via Twilio.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Twilio WhatsApp address, e.g. whatsapp:+521XXXXXXXXXX" },
          text: { type: "string", description: "Reply text. Long texts are split into 1600-character chunks." },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description: "Download media from a previously received Twilio WhatsApp message into ~/.claude/channels/wa-channel/inbox/.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Twilio WhatsApp address for the conversation." },
          message_id: { type: "string", description: "Twilio MessageSid from the inbound channel notification." },
        },
        required: ["chat_id", "message_id"],
      },
    },
    {
      name: "list_access_requests",
      description: "List pending WhatsApp access requests awaiting owner approval.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "approve_access_request",
      description: "Approve a pending WhatsApp access request by the code shown in wa-channel logs.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Access request code from the wa-channel container logs." },
        },
        required: ["code"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  if (name === "reply") {
    const args = ReplyArgs.parse(rawArgs ?? {});
    const chatId = normalizeWhatsAppAddress(args.chat_id);
    if (!(await isAllowlisted(chatId))) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: "chat_id is not allowlisted" }, null, 2),
          },
        ],
      };
    }

    const results = await twilioClient.sendMessage(chatId, args.text);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, sent: results }, null, 2),
        },
      ],
    };
  }

  if (name === "download_attachment") {
    const args = DownloadAttachmentArgs.parse(rawArgs ?? {});
    const paths = await downloadStoredAttachment(twilioClient, args.chat_id, args.message_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, paths }, null, 2),
        },
      ],
    };
  }

  if (name === "list_access_requests") {
    const pending = await listAccessRequests();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, pending }, null, 2),
        },
      ],
    };
  }

  if (name === "approve_access_request") {
    const args = ApproveAccessRequestArgs.parse(rawArgs ?? {});
    const result = await approveAccessRequest(args.code);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.approved ? { ok: true, from: result.from } : { ok: false, error: "access request code not found" }, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function emitChannelNotification(message: InboundMessage): Promise<void> {
  const attachmentNote = message.attachments.length
    ? `\n\n[${message.attachments.length} attachment(s) available. Use download_attachment with message_id=${message.message_id}.]`
    : "";

  await server.notification({
    method: "notifications/claude/channel",
    params: {
      source: "wa-channel",
      content: `${message.text}${attachmentNote}`,
      meta: {
        chat_id: message.chat_id,
        message_id: message.message_id,
        user: message.user,
        ts: message.ts,
      },
    },
  });
}

const webhookServer = startWebhookServer({
  port: Number.parseInt(process.env.WEBHOOK_PORT ?? "3000", 10),
  webhookUrl: process.env.WEBHOOK_URL,
  twilioAuthToken: twilioConfig.authToken,
  twilioClient,
  onMessage: emitChannelNotification,
});

console.error(`wa-channel webhook listening on port ${webhookServer.port}`);

function shutdown(): void {
  webhookServer.stop(true);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
