/** fetch 封装：JSON 进出、统一抽错误文案；401（登录接口除外）广播给 App 弹回登录页。 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: Record<string, unknown>,
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
    if (r.status === 401 && !url.startsWith("/api/login")) {
      clearSessionToken(); // 过期/被停用的 token 别留着,否则会盖过重新登录的 cookie
      if (!url.startsWith("/api/me")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(typeof data.error === "string" ? data.error : `HTTP ${r.status}`, r.status, data);
  }
  return data as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
