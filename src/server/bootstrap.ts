/**
 * First-boot seeding: when the user directory is empty, create the initial
 * admin from AJT_ADMIN_EMAIL / AJT_ADMIN_PASSWORD. Everyone else is created
 * by that admin in the 管理 tab.
 */

import type { UserStore } from "../stores/user-store.js";
import { hashPassword } from "./session.js";

export async function bootstrapAdmin(users: UserStore): Promise<void> {
  if ((await users.all()).length > 0) return;
  const email = process.env.AJT_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.AJT_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn("⚠ 用户表为空且未设置 AJT_ADMIN_EMAIL / AJT_ADMIN_PASSWORD —— 无人能登录，请配置后重启");
    return;
  }
  await users.upsert({
    email,
    name: email.split("@")[0],
    level: "admin",
    scrypt: await hashPassword(password),
    active: true,
    createdAt: new Date().toISOString(),
  });
  console.log(`已创建初始管理员 ${email}`);
}
