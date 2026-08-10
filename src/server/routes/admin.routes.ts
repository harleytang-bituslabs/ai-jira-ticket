/**
 * /api/admin/* — 用户管理(建号 / 定级 / 重置密码 / 停用)。整组路由在
 * app.ts 挂载时套 requireAdmin。
 *
 * 防呆:任何会导致"零个活跃管理员"的改动(降级/停用最后一个 admin)都被拒。
 */

import { Router } from "express";
import type { ResolvedConfig } from "../../core/config.js";
import { readProjectsCache, readRoster } from "../../core/spec-cache.js";
import type { CacheStore } from "../../stores/cache-store.js";
import { ACCOUNT_ID_RE, TEAMS, USER_LEVELS, type Team, type UserLevel, type UserRecord, type UserStore } from "../../stores/user-store.js";
import { HttpError } from "../middlewares/error.js";
import { hashPassword } from "../session.js";

const adminView = (u: UserRecord): Record<string, unknown> => ({
  email: u.email,
  name: u.name,
  level: u.level,
  boards: u.boards,
  team: u.team ?? null,
  active: u.active,
  createdAt: u.createdAt,
});

const isLevel = (v: unknown): v is UserLevel => typeof v === "string" && (USER_LEVELS as readonly string[]).includes(v);

/** 空串 = 清空;其余必须是预设团队之一。 */
const parseTeam = (v: unknown): Team | undefined => {
  if (typeof v !== "string") throw new HttpError(400, "team 须为字符串");
  const t = v.trim();
  if (!t) return undefined;
  if (!(TEAMS as readonly string[]).includes(t)) {
    throw new HttpError(400, `未知团队: ${t}（可选: ${TEAMS.join("/")}）`);
  }
  return t as Team;
};

export function adminRoutes(config: ResolvedConfig, users: UserStore, cache: CacheStore): Router {
  const router = Router();

  /**
   * 授权候选 = 全公司 board 清单（「更新config」拉的 projects.json），已接入的
   * 永远兜底在内。可以授权还没接入的 board —— 那只是前瞻记录，开票要等接入；
   * 但清单外的 key 一律拒：拼错的 key 会变成一个谁也进不去的隐形权限。
   */
  const knownBoards = async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    m.set(config.projectKey, config.projectKey);
    for (const p of (await readProjectsCache(cache)).projects) m.set(p.key, p.name);
    return m;
  };

  const parseBoards = async (v: unknown): Promise<string[]> => {
    if (!Array.isArray(v) || v.some((b) => typeof b !== "string")) {
      throw new HttpError(400, "boards 须为字符串数组");
    }
    const known = await knownBoards();
    for (const b of v as string[]) {
      if (!known.has(b)) throw new HttpError(400, `未知的 board: ${b}——点「更新config」刷新公司 board 清单后再试`);
    }
    return [...new Set(v as string[])];
  };

  router.get("/users", async (_req, res) => {
    res.json({ users: (await users.all()).map(adminView) });
  });

  /** 管理页「可见 board」下拉的候选：全公司 board，已接入的排最前，其余按 key。 */
  router.get("/boards", async (_req, res) => {
    const known = await knownBoards();
    const connected = [config.projectKey];
    const rest = [...known.keys()].filter((k) => !connected.includes(k)).sort();
    res.json({ boards: [...connected, ...rest].map((key) => ({ key, name: known.get(key) ?? key })) });
  });

  /**
   * 一个邮箱在哪些已接入 board 里有参与记录 —— 建号时据此预勾可见 board,
   * 免得管理员靠记忆猜。判据是该 board 的参与者名册(「更新config」拉的那份)。
   *
   * 识别只是建议:返回空不代表这人不该有权限,管理员仍可手动勾任意 board。
   */
  router.get("/participation", async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email) throw new HttpError(400, "email 不能为空");
    const boards: string[] = [];
    for (const key of [config.projectKey]) {
      const roster = await readRoster(cache);
      if (roster.members.some((m) => m.email.toLowerCase() === email)) boards.push(key);
    }
    res.json({ boards });
  });

  router.post("/users", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!ACCOUNT_ID_RE.test(email)) throw new HttpError(400, "登录名须是工作邮箱或纯用户名(字母数字开头)");
    if (!name) throw new HttpError(400, "姓名不能为空");
    if (password.length < 8) throw new HttpError(400, "初始密码至少 8 位");
    if (!isLevel(body.level)) throw new HttpError(400, `level 须为 ${USER_LEVELS.join("/")}`);
    if (await users.get(email)) throw new HttpError(409, `账号 ${email} 已存在`);

    const team = body.team === undefined ? undefined : parseTeam(body.team);
    const user: UserRecord = {
      email,
      name,
      level: body.level,
      // 不给就是空 —— 新账号默认什么 board 都看不到,由管理员显式开通
      boards: body.boards === undefined ? [] : await parseBoards(body.boards),
      ...(team ? { team } : {}),
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
    if (body.boards !== undefined) {
      next.boards = await parseBoards(body.boards);
    }
    if (body.team !== undefined) {
      const t = parseTeam(body.team);
      if (t) next.team = t;
      else delete next.team;
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
