import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome: string;
let allowlist: any;
let originalChannelHome: string | undefined;

beforeAll(async () => {
  originalChannelHome = process.env.WA_CHANNEL_HOME;
  tempHome = await mkdtemp(join(tmpdir(), "wa-channel-access-"));
  process.env.WA_CHANNEL_HOME = join(tempHome, "wa-channel");
  allowlist = await import(`./allowlist.ts?test=${Date.now()}`);
});

afterAll(async () => {
  if (originalChannelHome === undefined) delete process.env.WA_CHANNEL_HOME;
  else process.env.WA_CHANNEL_HOME = originalChannelHome;
  await rm(tempHome, { recursive: true, force: true });
});

test("access requests stay pending until owner approval by code", async () => {
  const requested = await allowlist.issueAccessRequest("+15551234567");

  expect(requested.from).toBe("whatsapp:+15551234567");
  expect(requested.code).toMatch(/^[A-F0-9]{8}$/);
  expect(await allowlist.isAllowlisted("+15551234567")).toBe(false);
  expect(await allowlist.listAccessRequests()).toEqual([
    { from: "whatsapp:+15551234567", createdAt: requested.createdAt },
  ]);

  expect(await allowlist.approveAccessRequest("WRONG-CODE")).toEqual({ approved: false });
  expect(await allowlist.isAllowlisted("+15551234567")).toBe(false);

  expect(await allowlist.approveAccessRequest(requested.code)).toEqual({
    approved: true,
    from: "whatsapp:+15551234567",
  });
  expect(await allowlist.isAllowlisted("+15551234567")).toBe(true);
  expect(await allowlist.listAccessRequests()).toEqual([]);
});

test("repeat access requests do not rotate the owner-visible code", async () => {
  const first = await allowlist.issueAccessRequest("+15557654321");
  const second = await allowlist.issueAccessRequest("whatsapp:+15557654321");

  expect(first.alreadyPending).toBe(false);
  expect(second).toEqual({
    from: "whatsapp:+15557654321",
    code: "",
    createdAt: first.createdAt,
    alreadyPending: true,
  });
  expect(await allowlist.listAccessRequests()).toEqual([
    { from: "whatsapp:+15557654321", createdAt: first.createdAt },
  ]);
});
