/**
 * The error taxonomy, shared by the server and the CLI.
 *
 * An HTTP status is a transport fact; the frontend needs a product fact — is
 * this your session, your input, or a third party? Carrying only the status
 * meant a provider's 401 could masquerade as ours (a dead ANTHROPIC_API_KEY
 * logged everybody out). `category` is that second channel.
 *
 * Deliberately HTTP-free: AppError carries no status. The category → status
 * table lives in server/middlewares/error.ts and nowhere else, which is what
 * lets src/core stay a pure library the CLI can use.
 */

export type ErrorCategory =
  /** Bad input the caller can fix where they are. */
  | "validation"
  /** Wrong password / wrong old password. Never a reason to drop a session. */
  | "credentials"
  /** No session, expired, or the account was deactivated. */
  | "session"
  /** Authenticated but not allowed. Their admin fixes it. */
  | "forbidden"
  /** A third party failed, or refused *our* credentials. Nobody can fix it now. */
  | "upstream"
  /** Our bug. An engineer fixes it. */
  | "internal"
  /** Submit stopped partway: N of M tickets already exist in Jira, irreversibly. */
  | "partial";

/** Enough state for the UI to tell the user what already happened, and resume. */
export interface PartialRecovery {
  id: string;
  draft: unknown;
  created: number;
  total: number;
}

export interface AppErrorInit {
  category: ErrorCategory;
  /** snake_case discriminator, shared by the logs and the frontend. */
  code: string;
  /** One sentence, ready to render. No upstream prose, bucket names or stacks. */
  message: string;
  /** Redacted upstream context — folded away in the UI, always in the log. */
  detail?: string;
  retryAfter?: number;
  recovery?: PartialRecovery;
  cause?: unknown;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly detail?: string;
  readonly retryAfter?: number;
  readonly recovery?: PartialRecovery;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "AppError";
    this.category = init.category;
    this.code = init.code;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
    if (init.recovery !== undefined) this.recovery = init.recovery;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

type Extra = Omit<AppErrorInit, "category" | "code" | "message">;

const make =
  (category: ErrorCategory) =>
  (code: string, message: string, extra: Extra = {}): AppError =>
    new AppError({ category, code, message, ...extra });

export const invalid = make("validation");
export const credentials = make("credentials");
export const sessionError = make("session");
export const forbidden = make("forbidden");
export const upstream = make("upstream");
export const internal = make("internal");

export const partial = (message: string, recovery: PartialRecovery, cause?: unknown): AppError =>
  new AppError({ category: "partial", code: "submit_partial", message, recovery, ...(cause !== undefined ? { cause } : {}) });
