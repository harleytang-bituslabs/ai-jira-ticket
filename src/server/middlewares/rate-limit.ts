/**
 * Login rate limit: at most 10 failures per (IP, email) within 15 minutes.
 * In-memory sliding window — single-instance assumption; move to a shared
 * store if the service ever scales out.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

const fails = new Map<string, { count: number; resetAt: number }>();

const keyOf = (ip: string, email: string): string => `${ip}|${email.toLowerCase()}`;

export function loginBlocked(ip: string, email: string): boolean {
  const key = keyOf(ip, email);
  const entry = fails.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    fails.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}

export function recordLoginFailure(ip: string, email: string): void {
  const key = keyOf(ip, email);
  const entry = fails.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    fails.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(ip: string, email: string): void {
  fails.delete(keyOf(ip, email));
}
