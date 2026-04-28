import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type AccessRequest = {
  from: string;
  codeHash: string;
  createdAt: string;
};

export type AccessConfig = {
  allowFrom: string[];
  dmPolicy: "allowlisted";
  pending: AccessRequest[];
};

const LEGACY_PENDING_KEY = "pairings";

type RawAccessConfig = Partial<Omit<AccessConfig, "pending">> & {
  pending?: unknown;
  pairings?: unknown;
};

export const CHANNEL_HOME = process.env.WA_CHANNEL_HOME ?? join(homedir(), ".claude", "channels", "wa-channel");
export const ACCESS_PATH = join(CHANNEL_HOME, "access.json");
const LEGACY_PENDING_PATH = join(CHANNEL_HOME, "pairing.json");

const DEFAULT_ACCESS: AccessConfig = { allowFrom: [], dmPolicy: "allowlisted", pending: [] };

async function ensureHome(): Promise<void> {
  await mkdir(CHANNEL_HOME, { recursive: true });
}

export function normalizeWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("whatsapp:")) return trimmed;
  if (trimmed.startsWith("+")) return `whatsapp:${trimmed}`;
  return trimmed;
}

function normalizePending(value: unknown): AccessRequest[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const candidate = entry as Partial<AccessRequest>;
      if (!candidate.from || !candidate.codeHash || !candidate.createdAt) return undefined;
      return {
        from: normalizeWhatsAppAddress(String(candidate.from)),
        codeHash: String(candidate.codeHash),
        createdAt: String(candidate.createdAt),
      };
    })
    .filter((entry): entry is AccessRequest => Boolean(entry));
}

async function readLegacyPending(): Promise<AccessRequest[]> {
  try {
    const parsed = JSON.parse(await readFile(LEGACY_PENDING_PATH, "utf8")) as { pairings?: unknown };
    return normalizePending(parsed.pairings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function readAccessConfig(): Promise<AccessConfig> {
  await ensureHome();
  try {
    const parsed = JSON.parse(await readFile(ACCESS_PATH, "utf8")) as RawAccessConfig;
    const rawPending = parsed.pending ?? parsed[LEGACY_PENDING_KEY];
    const access: AccessConfig = {
      allowFrom: Array.isArray(parsed.allowFrom)
        ? parsed.allowFrom.map((n) => normalizeWhatsAppAddress(String(n)))
        : [],
      dmPolicy: "allowlisted",
      pending: normalizePending(rawPending),
    };
    if (rawPending === undefined) {
      access.pending = await readLegacyPending();
    }
    return access;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeAccessConfig(DEFAULT_ACCESS);
    return { ...DEFAULT_ACCESS, allowFrom: [], pending: [] };
  }
}

export async function writeAccessConfig(config: AccessConfig): Promise<void> {
  await mkdir(dirname(ACCESS_PATH), { recursive: true });
  const clean: AccessConfig = {
    allowFrom: Array.from(new Set(config.allowFrom.map(normalizeWhatsAppAddress))).sort(),
    dmPolicy: "allowlisted",
    pending: normalizePending(config.pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
  await writeFile(ACCESS_PATH, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

export async function isAllowlisted(from: string): Promise<boolean> {
  const access = await readAccessConfig();
  return access.allowFrom.includes(normalizeWhatsAppAddress(from));
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

export async function issueAccessRequest(from: string): Promise<{ from: string; code: string; createdAt: string; alreadyPending: boolean }> {
  const normalized = normalizeWhatsAppAddress(from);
  const access = await readAccessConfig();
  const existing = access.pending.find((p) => p.from === normalized);
  if (existing) {
    return { from: normalized, code: "", createdAt: existing.createdAt, alreadyPending: true };
  }

  const code = randomBytes(4).toString("hex").toUpperCase();
  const createdAt = new Date().toISOString();
  access.pending.push({ from: normalized, codeHash: hashCode(code), createdAt });
  await writeAccessConfig(access);
  console.error(`wa-channel access request: from=${normalized} code=${code} createdAt=${createdAt}`);
  return { from: normalized, code, createdAt, alreadyPending: false };
}

export async function hasPendingAccessRequest(from: string): Promise<boolean> {
  const normalized = normalizeWhatsAppAddress(from);
  const access = await readAccessConfig();
  return access.pending.some((p) => p.from === normalized);
}

export async function listAccessRequests(): Promise<Array<{ from: string; createdAt: string }>> {
  const access = await readAccessConfig();
  return access.pending.map(({ from, createdAt }) => ({ from, createdAt }));
}

export async function approveAccessRequest(code: string): Promise<{ approved: boolean; from?: string }> {
  const access = await readAccessConfig();
  const match = access.pending.find((p) => codeEquals(code, p.codeHash));
  if (!match) return { approved: false };

  if (!access.allowFrom.includes(match.from)) {
    access.allowFrom.push(match.from);
  }
  access.pending = access.pending.filter((p) => p !== match);
  await writeAccessConfig(access);
  return { approved: true, from: match.from };
}
