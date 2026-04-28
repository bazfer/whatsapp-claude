import twilio from "twilio";
import { chunkMessage } from "./chunker";

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

  async downloadMedia(mediaUrl: string): Promise<Blob> {
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

    return await response.blob();
  }
}
