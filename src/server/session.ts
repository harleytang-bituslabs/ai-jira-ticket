/**
 * Auth primitives — zero dependencies, node:crypto only.
 *
 * Passwords: scrypt (memory-hard KDF) with a per-user random salt, verified
 * via timingSafeEqual.
 *
 * Sessions: stateless signed cookie. Token = base64url(payload).base64url(
 * HMAC-SHA256(payload, secret)) where payload = {sub: email, exp}. No session
 * store means container restarts / horizontal scaling don't log anyone out.
 * Level/active are NOT trusted from the cookie — middleware re-reads the user
 * directory on every request, so disabling an account takes effect at once.
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export interface ScryptHash {
  salt: string;
  hash: string;
}

export async function hashPassword(password: string): Promise<ScryptHash> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString("hex") };
}

export async function verifyPassword(password: string, stored: ScryptHash): Promise<boolean> {
  const hash = await scrypt(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export const SESSION_COOKIE = "ajt_session";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(email: string, secret: string, ttlMs = SESSION_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ sub: email, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the session's email, or null for missing/tampered/expired tokens. */
export function verifySessionToken(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: unknown; exp?: unknown };
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}
