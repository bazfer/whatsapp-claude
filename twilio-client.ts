import twilio from "twilio";
import { chunkMessage } from "./chunker";

export const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export type DownloadMediaOptions = {
  maxBytes?: number;
  allowedContentTypes?: readonly string[];
};

export type DownloadedMedia = {
  bytes: Uint8Array;
  contentType: string;
};

function mediaLimitFromEnv(): number {
  const raw = process.env.WA_CHANNEL_MAX_MEDIA_BYTES;
  if (!raw) return DEFAULT_MAX_MEDIA_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("WA_CHANNEL_MAX_MEDIA_BYTES must be a positive integer");
  }
  return parsed;
}

function isAllowedContentType(contentType: string, allowed?: readonly string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/*")) return normalized.startsWith(rule.slice(0, -1));
    return normalized === rule;
  });
}

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  from: string;
};

export type SendMessageResult = {
  sid: string;
  status: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function getTwilioConfigFromEnv(): TwilioConfig {
  return {
    accountSid: requiredEnv("TWILIO_ACCOUNT_SID"),
    authToken: requiredEnv("TWILIO_AUTH_TOKEN"),
    from: requiredEnv("TWILIO_PHONE_NUMBER"),
  };
}

export class TwilioWhatsAppClient {
  private readonly client: ReturnType<typeof twilio>;
  private readonly from: string;

  constructor(config = getTwilioConfigFromEnv()) {
    this.client = twilio(config.accountSid, config.authToken);
    this.from = config.from;
  }

  async sendMessage(to: string, text: string): Promise<SendMessageResult[]> {
    const chunks = chunkMessage(text);
    const results: SendMessageResult[] = [];

    for (const body of chunks) {
      const message = await this.client.messages.create({
        from: this.from,
        to,
        body,
      });
      results.push({ sid: message.sid, status: message.status });
    }

    return results;
  }

  async downloadMedia(mediaUrl: string, options: DownloadMediaOptions = {}): Promise<DownloadedMedia> {
    const maxBytes = options.maxBytes ?? mediaLimitFromEnv();
    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID ?? ""}:${process.env.TWILIO_AUTH_TOKEN ?? ""}`,
        ).toString("base64")}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Twilio media download failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!isAllowedContentType(contentType, options.allowedContentTypes)) {
      throw new Error(`Twilio media content type is not allowed: ${contentType}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        throw new Error(`Twilio media exceeds limit of ${maxBytes} bytes`);
      }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Twilio media exceeds limit of ${maxBytes} bytes after download`);
    }

    return { bytes: new Uint8Array(buffer), contentType };
  }
}
