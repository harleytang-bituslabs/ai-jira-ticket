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

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || data.error) {
    if (r.status === 401 && !url.startsWith("/api/login") && !url.startsWith("/api/me")) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(typeof data.error === "string" ? data.error : `HTTP ${r.status}`, r.status, data);
  }
  return data as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
