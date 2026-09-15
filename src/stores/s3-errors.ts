/**
 * Translates AWS SDK failures into our taxonomy.
 *
 * S3ServiceException keeps its status nested in `$metadata.httpStatusCode`, so
 * these never wore a foreign status the way Anthropic's did — they just landed
 * as generic 400s with the AWS message, which names the bucket and the key.
 * That text is operator-facing: it goes to `detail` and the log, never to the
 * sentence the user reads.
 *
 * Callers keep handling NoSuchKey themselves — "no such object" is usually a
 * normal state (a fresh deployment, a draft that was never written), not a
 * failure.
 */

import { upstream, type AppError } from "../core/errors.js";

export const isNoSuchKey = (err: unknown): boolean => {
  const name = (err as { name?: string }).name;
  return name === "NoSuchKey" || name === "NotFound";
};

/** `op` is a short label for the log, e.g. "GetObject drafts/alice/x.json". */
export function s3Error(err: unknown, op: string): AppError {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  return upstream("storage_unavailable", "存储服务暂时不可用，请稍后重试", {
    detail: `${op}: ${e.name ?? "Error"}${status ? ` (HTTP ${status})` : ""} — ${e.message ?? ""}`,
    cause: err,
  });
}
