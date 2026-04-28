import { afterEach, describe, expect, test } from "bun:test";
import { TwilioWhatsAppClient } from "./twilio-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): TwilioWhatsAppClient {
  return new TwilioWhatsAppClient({
    accountSid: "AC00000000000000000000000000000000",
    authToken: "token",
    from: "whatsapp:+15551234567",
  });
}

function mockFetchResponse(response: Response): void {
  globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
}

describe("TwilioWhatsAppClient.downloadMedia", () => {
  test("streams media without Content-Length and returns bytes within the limit", async () => {
    mockFetchResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3]));
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );

    const media = await client().downloadMedia("https://api.twilio.test/media", {
      maxBytes: 3,
      allowedContentTypes: ["image/*"],
    });

    expect([...media.bytes]).toEqual([1, 2, 3]);
    expect(media.contentType).toBe("image/png");
  });

  test("rejects and cancels the stream as soon as media without Content-Length exceeds the limit", async () => {
    let canceled = false;
    let pulls = 0;
    const chunks = Array.from({ length: 100 }, (_, index) => new Uint8Array([index, index, index]));
    const totalChunks = chunks.length;

    mockFetchResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );

    await expect(
      client().downloadMedia("https://api.twilio.test/media", {
        maxBytes: 5,
        allowedContentTypes: ["image/*"],
      }),
    ).rejects.toThrow("Twilio media exceeds limit of 5 bytes during download");

    expect(canceled).toBe(true);
    expect(pulls).toBeLessThan(totalChunks);
  });
});
