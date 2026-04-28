import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type AccessConfig = {
  allowFrom: string[];
  dmPolicy: "allowlisted";
};

type PendingPairing = {
  from: string;
  codeHash: string;
  createdAt: string;
};

type PendingConfig = {
  pairings: PendingPairing[];
};

export const CHANNEL_HOME = join(homedir(), ".claude", "channels", "wa-channel");
export const ACCESS_PATH = join(CHANNEL_HOME, "access.json");
const PENDING_PATH = join(CHANNEL_HOME, "pairing.json");

const DEFAULT_ACCESS: AccessConfig = { allowFrom: [], dmPolicy: "allowlisted" };

async function ensureHome(): Promise<void> {
  await mkdir(CHANNEL_HOME, { recursive: true });
}

export function normalizeWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("whatsapp:")) return trimmed;
  if (trimmed.startsWith("+")) return `whatsapp:${trimmed}`;
  return trimmed;
}

export async function readAccessConfig(): Promise<AccessConfig> {
  await ensureHome();
  try {
    const parsed = JSON.parse(await readFile(ACCESS_PATH, "utf8")) as Partial<AccessConfig>;
    return {
      allowFrom: Array.isArray(parsed.allowFrom)
        ? parsed.allowFrom.map((n) => normalizeWhatsAppAddress(String(n)))
        : [],
      dmPolicy: "allowlisted",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeAccessConfig(DEFAULT_ACCESS);
    return DEFAULT_ACCESS;
  }
}

export async function writeAccessConfig(config: AccessConfig): Promise<void> {
  await mkdir(dirname(ACCESS_PATH), { recursive: true });
  const clean: AccessConfig = {
    allowFrom: Array.from(new Set(config.allowFrom.map(normalizeWhatsAppAddress))).sort(),
    dmPolicy: "allowlisted",
  };
  await writeFile(ACCESS_PATH, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

export async function isAllowlisted(from: string): Promise<boolean> {
  const access = await readAccessConfig();
  return access.allowFrom.includes(normalizeWhatsAppAddress(from));
}

async function readPending(): Promise<PendingConfig> {
  await ensureHome();
  try {
    const parsed = JSON.parse(await readFile(PENDING_PATH, "utf8")) as Partial<PendingConfig>;
    return { pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { pairings: [] };
  }
}

async function writePending(config: PendingConfig): Promise<void> {
  await ensureHome();
  await writeFile(PENDING_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function hashCode(code: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(code);
  return hasher.digest("hex");
}

function codeEquals(code: string, hash: string): boolean {
  const left = Buffer.from(hashCode(code), "hex");
  const right = Buffer.from(hash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function issuePairingCode(from: string): Promise<string> {
  const normalized = normalizeWhatsAppAddress(from);
  const code = randomBytes(4).toString("hex").toUpperCase();
  const pending = await readPending();
  const fresh = pending.pairings.filter((p) => p.from !== normalized);
  fresh.push({ from: normalized, codeHash: hashCode(code), createdAt: new Date().toISOString() });
  await writePending({ pairings: fresh });
  return code;
}

export async function hasPendingPairingCode(from: string): Promise<boolean> {
  const normalized = normalizeWhatsAppAddress(from);
  const pending = await readPending();
  return pending.pairings.some((p) => p.from === normalized);
}

export async function allowWithPairingCode(from: string, code: string): Promise<boolean> {
  const normalized = normalizeWhatsAppAddress(from);
  const pending = await readPending();
  const match = pending.pairings.find((p) => p.from === normalized && codeEquals(code, p.codeHash));
  if (!match) return false;

  const access = await readAccessConfig();
  if (!access.allowFrom.includes(normalized)) {
    access.allowFrom.push(normalized);
    await writeAccessConfig(access);
  }
  await writePending({ pairings: pending.pairings.filter((p) => p !== match) });
  return true;
}
