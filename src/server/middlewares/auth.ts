/**
 * Session middleware chain: attachAuth verifies the Authorization header and
 * mounts req.user (fresh from the user directory — the token carries identity
 * only, never level or active status); requireAuth / requireAdmin guard routes.
 *
 * Header-only on purpose: the token lives in each tab's sessionStorage, so one
 * computer can hold several accounts at once. A cookie fallback would undo
 * that — the browser shares cookies across tabs, so the last login would
 * silently take over every tab that lacks its own token.
 */

import type { NextFunction, Request, Response } from "express";
import { forbidden, sessionError } from "../../core/errors.js";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
import { verifySessionToken } from "../session.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

export function attachAuth(users: UserStore, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
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

// Express 5 forwards synchronous throws to the error handler, which is what
// gives these responses a category — 401 alone can no longer be told apart
// from a provider's 401.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw sessionError("session_expired", "未登录或会话已过期");
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw sessionError("session_expired", "未登录或会话已过期");
  if (req.user.level !== "admin") throw forbidden("admin_required", "需要管理员权限");
  next();
}
