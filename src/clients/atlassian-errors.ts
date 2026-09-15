/**
 * Translates Atlassian's HTTP dialect into our taxonomy, for both Jira and
 * Confluence.
 *
 * Provenance has to be recorded here: once an error reaches the server's error
 * handler, a bare 401 is indistinguishable between Atlassian, Anthropic and our
 * own session check — which is exactly the confusion that logged people out.
 *
 * The split that matters: `message` is what the end user reads, `detail` is
 * what an operator reads. Atlassian rejecting *our* service token is never the
 * user's problem, so the remediation prose ("regenerate at id.atlassian.com…")
 * belongs in detail, not in their face.
 */

import { invalid, upstream, type AppError } from "../core/errors.js";

export type AtlassianService = "Jira" | "Confluence";

/** Jira packs the actionable part into errorMessages/errors; everything else is noise. */
async function readDetail(res: Response): Promise<{ says: string[]; raw: string }> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const says: string[] = [];
    if (body.errorMessages?.length) says.push(...body.errorMessages);
    if (body.errors) says.push(...Object.entries(body.errors).map(([field, msg]) => `${field}: ${msg}`));
    return { says, raw: text };
  } catch {
    return { says: [], raw: text };
  }
}

export async function atlassianError(service: AtlassianService, res: Response, path: string): Promise<AppError> {
  const { says, raw } = await readDetail(res);
  const detail = [`${service} ${path} → HTTP ${res.status}`, says.length ? `${service} says: ${says.join("; ")}` : "", raw.slice(0, 500)]
    .filter(Boolean)
    .join("\n");

  // 400 from Jira is field-level validation — the one Atlassian failure the
  // user can actually act on, so its field messages stay in the headline.
  if (res.status === 400) {
    return invalid("atlassian_rejected", says.length ? `${service} 拒绝了该请求：${says.join("；")}` : `${service} 拒绝了该请求`, {
      detail,
    });
  }
  if (res.status === 401) {
    return upstream("atlassian_auth", `${service} 拒绝了服务的 API 令牌，请联系管理员更新配置`, {
      detail: `${detail}\nRegenerate at id.atlassian.com/manage-profile/security/api-tokens and update ATLASSIAN_API_TOKEN.`,
    });
  }
  if (res.status === 403) {
    return upstream("atlassian_denied", `服务账号没有访问该 ${service} 资源的权限，请联系管理员`, { detail });
  }
  if (res.status === 404) {
    return upstream("atlassian_not_found", `${service} 上找不到对应的资源，可能已被删除或移动`, { detail });
  }
  if (res.status === 429) {
    return upstream("atlassian_unavailable", `${service} 暂时限流，请稍后重试`, { detail });
  }
  if (res.status >= 500) {
    return upstream("atlassian_unavailable", `${service} 暂时不可用，请稍后重试`, { detail });
  }
  return upstream("atlassian_http", `${service} 返回了错误（HTTP ${res.status}）`, { detail });
}

/** fetch itself rejected: timeout, DNS, TLS. Never a user-input problem. */
export function atlassianNetworkError(service: AtlassianService, path: string, err: unknown): AppError {
  const name = (err as { name?: string }).name;
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError") {
    return upstream("upstream_timeout", `${service} 30 秒未响应，请稍后重试`, { detail: `${path}: ${message}`, cause: err });
  }
  return upstream("upstream_unreachable", `无法连接 ${service}，请检查网络后重试`, {
    detail: `${path}: ${message}`,
    cause: err,
  });
}
