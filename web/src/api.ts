/** fetch 封装：JSON 进出、统一抽错误文案；只有 category === "session" 才广播登出。 */

import { classify, type Category } from "./errors";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: Record<string, unknown>,
    /** 服务端的分类字段（src/core/errors.ts）。老响应没有就是 undefined。 */
    public readonly wire?: { category?: string; code?: string; detail?: string; requestId?: string },
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = "ajt:unauthorized";

/**
 * 会话 token 放 sessionStorage —— 按标签页隔离,一台电脑开两个标签页就能登两个
 * 账号。cookie 仍在(服务端兜底),但只要有 token,Authorization 头优先生效。
 */
const TOKEN_KEY = "ajt.token";
export const setSessionToken = (t: string): void => sessionStorage.setItem(TOKEN_KEY, t);
export const clearSessionToken = (): void => sessionStorage.removeItem(TOKEN_KEY);

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const r = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || data.error) {
    const wire = {
      ...(typeof data.category === "string" ? { category: data.category } : {}),
      ...(typeof data.code === "string" ? { code: data.code } : {}),
      ...(typeof data.detail === "string" ? { detail: data.detail } : {}),
      ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
    };
    // 只有服务端说「你的会话没了」才清 token。以前是「见 401 就清」,于是
    // Anthropic 的 401(API key 失效)和输错旧密码都能把人踢出去。
    const isSession = wire.category
      ? wire.category === "session"
      : r.status === 401 && !url.startsWith("/api/login"); // 老响应的退路
    if (isSession) {
      clearSessionToken();
      if (!url.startsWith("/api/me")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(typeof data.error === "string" ? data.error : `HTTP ${r.status}`, r.status, data, wire);
  }
  return data as T;
}

export const errMsg = (e: unknown): string => classify(e).text;

export type { Category };
