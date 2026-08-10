/** /api/login · /api/logout · /api/me · /api/me/password */

import { Router } from "express";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
import { requireAuth } from "../middlewares/auth.js";
import { clearLoginFailures, loginBlocked, recordLoginFailure } from "../middlewares/rate-limit.js";
import { SESSION_COOKIE, SESSION_TTL_MS, createSessionToken, hashPassword, verifyPassword } from "../session.js";

/** 对前端暴露的用户信息(绝不含口令哈希)。 */
export const publicUser = (
  u: UserRecord,
): { email: string; name: string; level: string; boards: string[]; team: string | null } => ({
  email: u.email,
  name: u.name,
  level: u.level,
  boards: u.boards,
  team: u.team ?? null,
});

export function authRoutes(users: UserStore, secret: string): Router {
  const router = Router();

  router.post("/login", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      res.status(400).json({ error: "邮箱和密码不能为空" });
      return;
    }
    const ip = req.ip ?? "?";
    if (loginBlocked(ip, email)) {
      res.status(429).json({ error: "失败次数过多，请 15 分钟后再试" });
      return;
    }
    const user = await users.get(email);
    // 统一的失败文案,不泄露账号是否存在/是否被停用
    if (!user || !user.active || !(await verifyPassword(password, user.scrypt))) {
      recordLoginFailure(ip, email);
      res.status(401).json({ error: "邮箱或密码不正确" });
      return;
    }
    clearLoginFailures(ip, email);
    res.cookie(SESSION_COOKIE, createSessionToken(user.email, secret), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
      secure: process.env.AJT_COOKIE_SECURE === "1", // 上 HTTPS 后置 1
    });
    res.json({ user: publicUser(user) });
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  router.post("/me/password", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < 8) {
      res.status(400).json({ error: "新密码至少 8 位" });
      return;
    }
    const user = req.user!;
    if (!(await verifyPassword(oldPassword, user.scrypt))) {
      res.status(401).json({ error: "旧密码不正确" });
      return;
    }
    await users.upsert({ ...user, scrypt: await hashPassword(newPassword) });
    res.json({ ok: true });
  });

  return router;
}
