/**
 * Session middleware chain: attachAuth parses the cookie and mounts req.user
 * (fresh from the user directory — cookie carries identity only, never level
 * or active status); requireAuth / requireAdmin are the route guards.
 */

import type { NextFunction, Request, Response } from "express";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
import { SESSION_COOKIE, verifySessionToken } from "../session.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function attachAuth(users: UserStore, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const email = verifySessionToken(token, secret);
      if (email) {
        const user = await users.get(email);
        if (user?.active) req.user = user; // 禁用账号即刻失效(30s 目录缓存内)
      }
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "未登录或会话已过期" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "未登录或会话已过期" });
    return;
  }
  if (req.user.level !== "admin") {
    res.status(403).json({ error: "需要管理员权限" });
    return;
  }
  next();
}
