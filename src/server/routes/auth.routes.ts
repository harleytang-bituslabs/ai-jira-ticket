/** /api/login · /api/me · /api/me/password（登出=前端丢 token,服务端无状态） */

import { Router } from "express";
import { credentials, invalid } from "../../core/errors.js";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
import { requireAuth } from "../middlewares/auth.js";
import { clearLoginFailures, loginBlocked, recordLoginFailure } from "../middlewares/rate-limit.js";
import { createSessionToken, hashPassword, verifyPassword } from "../session.js";

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
    if (!email || !password) throw invalid("missing_credentials", "邮箱和密码不能为空");
    const ip = req.ip ?? "?";
    if (loginBlocked(ip, email)) throw invalid("rate_limit", "失败次数过多，请 15 分钟后再试");
    const user = await users.get(email);
    // 统一的失败文案,不泄露账号是否存在/是否被停用
    if (!user || !user.active || !(await verifyPassword(password, user.scrypt))) {
      recordLoginFailure(ip, email);
      // credentials,不是 session:前端据此只做内联提示,绝不清 token
      throw credentials("bad_credentials", "邮箱或密码不正确");
    }
    clearLoginFailures(ip, email);
    // token 只随响应给前端,存进标签页级的 sessionStorage 走 Authorization 头。
    // 刻意不种 cookie:cookie 是全浏览器共享的,会让最后登录的账号
    // 悄悄接管所有没有自己 token 的标签页 —— 一台电脑多账号就泡汤了。
    res.json({ user: publicUser(user), token: createSessionToken(user.email, secret) });
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  router.post("/me/password", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < 8) throw invalid("weak_password", "新密码至少 8 位");
    const user = req.user!;
    // 旧密码错是 credentials 而非 session —— 否则前端会把这个 401 当成会话失效,
    // 悄悄清掉本标签页的 token,用户只是打错一个字就被登出了。
    if (!(await verifyPassword(oldPassword, user.scrypt))) throw credentials("bad_credentials", "旧密码不正确");
    await users.upsert({ ...user, scrypt: await hashPassword(newPassword) });
    res.json({ ok: true });
  });

  return router;
}
