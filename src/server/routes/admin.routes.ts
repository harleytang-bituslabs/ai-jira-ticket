/**
 * /api/admin/* — 用户管理(建号 / 定级 / 重置密码 / 停用)。整组路由在
 * app.ts 挂载时套 requireAdmin。
 *
 * 防呆:任何会导致"零个活跃管理员"的改动(降级/停用最后一个 admin)都被拒。
 */

import { Router } from "express";
import { USER_LEVELS, type UserLevel, type UserRecord, type UserStore } from "../../stores/user-store.js";
import { HttpError } from "../middlewares/error.js";
import { hashPassword } from "../session.js";

const adminView = (u: UserRecord): Record<string, unknown> => ({
  email: u.email,
  name: u.name,
  jiraEmail: u.jiraEmail ?? null,
  level: u.level,
  active: u.active,
  createdAt: u.createdAt,
});

const isLevel = (v: unknown): v is UserLevel => typeof v === "string" && (USER_LEVELS as readonly string[]).includes(v);

export function adminRoutes(users: UserStore): Router {
  const router = Router();

  router.get("/users", async (_req, res) => {
    res.json({ users: (await users.all()).map(adminView) });
  });

  router.post("/users", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const jiraEmail = typeof body.jiraEmail === "string" && body.jiraEmail.trim() ? body.jiraEmail.trim().toLowerCase() : undefined;
    if (!/^[\w.+-]+@[\w.-]+$/.test(email)) throw new HttpError(400, "邮箱格式不正确");
    if (!name) throw new HttpError(400, "姓名不能为空");
    if (password.length < 8) throw new HttpError(400, "初始密码至少 8 位");
    if (!isLevel(body.level)) throw new HttpError(400, `level 须为 ${USER_LEVELS.join("/")}`);
    if (await users.get(email)) throw new HttpError(409, `账号 ${email} 已存在`);

    const user: UserRecord = {
      email,
      name,
      ...(jiraEmail ? { jiraEmail } : {}),
      level: body.level,
      scrypt: await hashPassword(password),
      active: true,
      createdAt: new Date().toISOString(),
    };
    await users.upsert(user);
    res.status(201).json({ user: adminView(user) });
  });

  router.patch("/users/:email", async (req, res) => {
    const email = req.params.email.trim().toLowerCase();
    const user = await users.get(email);
    if (!user) throw new HttpError(404, `账号 ${email} 不存在`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const next: UserRecord = { ...user };
    if (body.level !== undefined) {
      if (!isLevel(body.level)) throw new HttpError(400, `level 须为 ${USER_LEVELS.join("/")}`);
      next.level = body.level;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") throw new HttpError(400, "active 须为布尔值");
      next.active = body.active;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400, "姓名不能为空");
      next.name = body.name.trim();
    }
    if (body.jiraEmail !== undefined) {
      if (typeof body.jiraEmail !== "string") throw new HttpError(400, "jiraEmail 须为字符串");
      const v = body.jiraEmail.trim().toLowerCase();
      if (v) next.jiraEmail = v;
      else delete next.jiraEmail;
    }
    if (body.password !== undefined) {
      if (typeof body.password !== "string" || body.password.length < 8) throw new HttpError(400, "新密码至少 8 位");
      next.scrypt = await hashPassword(body.password);
    }

    // 最后一个活跃管理员不可被降级/停用,防止把自己锁在门外
    const losesAdmin = user.level === "admin" && user.active && (next.level !== "admin" || !next.active);
    if (losesAdmin) {
      const others = (await users.all()).filter(
        (u) => u.email.toLowerCase() !== email && u.level === "admin" && u.active,
      );
      if (others.length === 0) throw new HttpError(400, "不能移除最后一个活跃管理员");
    }

    await users.upsert(next);
    res.json({ user: adminView(next) });
  });

  return router;
}
