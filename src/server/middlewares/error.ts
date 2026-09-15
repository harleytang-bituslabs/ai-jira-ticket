/**
 * Tail middlewares: 404 for unmatched routes, unified error responses.
 *
 * This is the ONLY place in the repo where an HTTP status is chosen. Handlers
 * and the core library throw AppError, which carries a category but no status.
 *
 * A foreign error's status is never reused as ours. Forwarding it verbatim is
 * what let a dead ANTHROPIC_API_KEY (Anthropic replies 401) reach the browser
 * as our own 401, which the frontend reads as "session expired" and logs the
 * user out. Anything arriving with third-party provenance — a top-level
 * `status`, an AWS `$metadata`, an abort/timeout, a failed fetch — is
 * classified `upstream` instead.
 */

import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  AppError,
  isAppError,
  invalid,
  upstream,
  type ErrorCategory,
  type PartialRecovery,
} from "../../core/errors.js";

const CATEGORY_BY_STATUS: Record<number, ErrorCategory> = {
  400: "validation",
  401: "session",
  403: "forbidden",
  404: "validation",
  409: "validation",
};

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "session_expired",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

/** Kept for the ~25 existing `new HttpError(status, msg)` call sites: same
 *  signature, now an AppError underneath so routes need no edits at all —
 *  permission rules in particular stay put in services/policy.ts. */
export class HttpError extends AppError {
  constructor(status: number, message: string) {
    super({
      category: CATEGORY_BY_STATUS[status] ?? "validation",
      code: CODE_BY_STATUS[status] ?? "invalid_request",
      message,
    });
    this.name = "HttpError";
  }
}

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  credentials: 401,
  session: 401,
  forbidden: 403,
  upstream: 502,
  internal: 500,
  partial: 409,
};

/** Codes whose HTTP semantics differ from their category's default. Keeping
 *  these here (rather than adding categories) is what holds the taxonomy to 7. */
const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  draft_not_found: 404,
  account_not_found: 404,
  conflict: 409,
  account_exists: 409,
  cache_missing: 409,
  body_too_large: 413,
  unsupported_encoding: 415,
  rate_limit: 429,
  anthropic_unavailable: 503,
  atlassian_unavailable: 503,
  storage_unavailable: 503,
  upstream_timeout: 504,
};

export interface WireError {
  error: string;
  category: ErrorCategory;
  code: string;
  detail?: string;
  requestId: string;
  retryAfter?: number;
  recovery?: PartialRecovery;
  /** @deprecated Migration aliases for the partial-submit payload the Editor
   *  reads as `e.data.draft` today. Drop once it reads `recovery` instead. */
  id?: string;
  draft?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v));

/** Readable one-liner from a ZodError, so the JSON issue blob stops being UI text. */
function flattenZod(issues: unknown[]): string {
  return issues
    .map((i) => {
      const issue = i as { path?: unknown[]; message?: unknown };
      const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : "(根)";
      return `${path}: ${str(issue.message)}`;
    })
    .join("; ");
}

/**
 * Normalize anything thrown into an AppError.
 *
 * The fallback is deliberately `validation`/400, not `internal`/500: routes and
 * src/core still throw plain Errors for ordinary business failures ("input 不能
 * 为空"), and 400 is what they mean today. Those throw sites get real categories
 * as they are converted; until then the log marks them `unclassified` so they
 * stay visible rather than silently passing as user error.
 */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  const e = err as {
    name?: unknown;
    type?: unknown;
    status?: unknown;
    message?: unknown;
    issues?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (e.name === "ZodError" && Array.isArray(e.issues)) {
    return invalid("schema_invalid", "提交的数据结构不合法", { detail: flattenZod(e.issues), cause: err });
  }

  // body-parser errors carry both `type` and `status`; `type` is the reliable one.
  if (typeof e.type === "string") {
    if (e.type === "entity.parse.failed") return invalid("body_not_json", "请求体不是合法 JSON", { cause: err });
    if (e.type === "entity.too.large") return invalid("body_too_large", "请求体过大（上限 2MB）", { cause: err });
    if (e.type === "encoding.unsupported" || e.type === "charset.unsupported") {
      return invalid("unsupported_encoding", "不支持的请求编码", { cause: err });
    }
  }

  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return upstream("upstream_timeout", "外部服务未在超时时间内响应，请稍后重试", {
      detail: str(e.message),
      cause: err,
    });
  }

  if (typeof e.$metadata?.httpStatusCode === "number") {
    return upstream("storage_unavailable", "存储服务暂时不可用，请稍后重试", {
      detail: `${str(e.name)} (HTTP ${e.$metadata.httpStatusCode})`,
      cause: err,
    });
  }

  // A third party's HTTP status. Never ours.
  if (typeof e.status === "number" && e.status >= 400 && e.status < 600) {
    return upstream("upstream_http", "外部服务返回了错误，请稍后重试", {
      detail: `HTTP ${e.status}: ${str(e.message)}`,
      cause: err,
    });
  }

  if (err instanceof TypeError && /fetch failed/i.test(str(e.message))) {
    return upstream("upstream_unreachable", "无法连接外部服务，请检查网络后重试", {
      detail: str(e.message),
      cause: err,
    });
  }

  return invalid("unclassified", err instanceof Error ? err.message : str(err), { cause: err });
}

export const statusFor = (e: AppError): number => STATUS_BY_CODE[e.code] ?? STATUS_BY_CATEGORY[e.category];

export function toWire(e: AppError, requestId: string): WireError {
  return {
    error: e.message,
    category: e.category,
    code: e.code,
    requestId,
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
    ...(e.recovery !== undefined
      ? { recovery: e.recovery, id: e.recovery.id, draft: e.recovery.draft } // aliases: see WireError
      : {}),
  };
}

/** One line per error. `unclassified` gets a stack too — it is the queue of
 *  throw sites still waiting for a real category. Request bodies are never
 *  logged: they carry passwords. */
function logError(e: AppError, status: number, requestId: string, req: Request): void {
  const who = req.user?.email ?? "anon";
  const head = `ERR ${requestId} ${req.method} ${req.originalUrl} → ${status} ${e.category}/${e.code} user=${who} :: ${e.message}`;
  const tail = e.detail ? `\n  detail: ${e.detail}` : "";

  if (e.category === "upstream" || e.category === "internal" || e.category === "partial") {
    console.error(head + tail, "\n", e.stack ?? "");
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause !== e) console.error(`  cause: ${cause.name}: ${cause.message}`);
    return;
  }
  if (e.category === "forbidden" || e.code === "unclassified") {
    console.warn(head + tail, e.code === "unclassified" ? `\n ${e.stack ?? ""}` : "");
    return;
  }
  console.info(head + tail);
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "not found", category: "validation", code: "route_not_found", requestId: "-" });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = toAppError(err);
  const status = statusFor(e);
  const requestId = req.id ?? randomBytes(4).toString("hex");

  logError(e, status, requestId, req);

  if (e.retryAfter !== undefined) res.setHeader("Retry-After", String(e.retryAfter));
  res.status(status).json(toWire(e, requestId));
}
