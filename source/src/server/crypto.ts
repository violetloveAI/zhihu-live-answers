import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export class SecurityConfigurationError extends Error {
  readonly code = "SECURITY_NOT_CONFIGURED";
  readonly status = 503;
  constructor() { super("服务端登录保护尚未配置，请联系维护者。"); this.name = "SecurityConfigurationError"; }
}

/** Reject examples/short values; never report a secret or its fingerprint to clients. */
export function validSecret(value: string | undefined): value is string {
  return Boolean(value && Buffer.byteLength(value) >= 32 && !/^(change.?me|replace.?me|example|your[-_ ])/i.test(value) && new Set(value).size >= 8);
}

async function localSecret(name: string): Promise<string> {
  // These private files are created at runtime and must never become bundled assets.
  const root = path.resolve(/* turbopackIgnore: true */ process.env.AUTH_DATA_DIR || ".data/auth");
  await mkdir(/* turbopackIgnore: true */ root, { recursive: true, mode: 0o700 });
  const file = path.join(/* turbopackIgnore: true */ root, /* turbopackIgnore: true */ name);
  const temporary = `${file}.${randomBytes(12).toString("hex")}`;
  try {
    const handle = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
    try { await handle.writeFile(randomBytes(48).toString("base64url")); }
    finally { await handle.close(); }
    // Publish a complete file atomically; simultaneous first requests read the winner.
    await link(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SecurityConfigurationError();
  } finally { await unlink(/* turbopackIgnore: true */ temporary).catch(() => undefined); }
  const secret = (await readFile(/* turbopackIgnore: true */ file, "utf8")).trim();
  if (!validSecret(secret)) throw new SecurityConfigurationError();
  return secret;
}

export async function sessionSecret(): Promise<string> {
  if (validSecret(process.env.SESSION_SECRET)) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" || process.env.SESSION_SECRET) throw new SecurityConfigurationError();
  return localSecret("session-secret");
}

async function encryptionSecret(): Promise<string> {
  if (validSecret(process.env.TOKEN_ENCRYPTION_KEY)) return process.env.TOKEN_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === "production" || process.env.TOKEN_ENCRYPTION_KEY) throw new SecurityConfigurationError();
  return localSecret("token-encryption-secret");
}

export function randomToken(): string { return randomBytes(32).toString("base64url"); }

export async function hashToken(token: string, purpose = "session"): Promise<string> {
  return createHmac("sha256", await sessionSecret()).update(`${purpose}\0${token}`).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function encryptionKey(): Promise<Buffer> {
  return createHmac("sha256", await encryptionSecret()).update("live-answers:oauth-token:v1").digest();
}

/** Authenticated encryption binds a stored token to its owner/context. */
export async function encryptToken(token: string, context: string): Promise<string> {
  if (!token || !context) throw new Error("A token and encryption context are required.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export async function decryptToken(value: string, context: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !context) throw new Error("Invalid encrypted token.");
  const [, encodedIv, encodedTag, encodedCipher] = parts;
  const iv = Buffer.from(encodedIv, "base64url"), tag = Buffer.from(encodedTag, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted token.");
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(encodedCipher, "base64url")), decipher.final()]).toString("utf8");
}
