/**
 * 错误呈现的唯一决策点。
 *
 * 分类由服务端给（category/code，见 src/core/errors.ts —— 那里是唯一真相源，
 * 这里的联合类型是它的镜像，test/errors.test.ts 有一条守卫防止两边跑偏）。
 * 前端只决定一件事：这条错误该内联显示，还是该弹窗。
 *
 * 判据只有一句：**只有当用户否则会永久失去他无法恢复的信息时，才用弹窗**——
 * 要么不可逆的事已经发生（部分提交），要么消息马上会被重新挂载销毁（会话失效
 * 会把整页换成登录页），要么页面上根本没有地方承载它（后台动作）。
 */

/** 服务端分类 + 一个前端独有的:请求根本没发出去。 */
export type Category =
  | "validation"
  | "credentials"
  | "session"
  | "forbidden"
  | "upstream"
  | "internal"
  | "partial"
  | "network";

/** 四处结构相同的本地声明合并到这里（MainPage 的 Flash 也是它）。 */
export type Status = { text: string; cls?: "ok" | "error" };

export interface Problem {
  category: Category;
  code: string;
  text: string;
  detail?: string;
  requestId?: string;
}

export const ERROR_EVENT = "ajt:error";

const KNOWN: readonly Category[] = [
  "validation",
  "credentials",
  "session",
  "forbidden",
  "upstream",
  "internal",
  "partial",
  "network",
];

interface WireShape {
  category?: unknown;
  code?: unknown;
  detail?: unknown;
  requestId?: unknown;
}

/** ApiError 携带服务端分类;其余（TypeError/渲染崩溃）按形状猜。 */
export function classify(e: unknown): Problem {
  const text = e instanceof Error ? e.message : String(e);
  const wire = (e as { wire?: WireShape }).wire;

  if (wire && typeof wire.category === "string" && (KNOWN as readonly string[]).includes(wire.category)) {
    return {
      category: wire.category as Category,
      code: typeof wire.code === "string" ? wire.code : "unknown",
      text,
      ...(typeof wire.detail === "string" ? { detail: wire.detail } : {}),
      ...(typeof wire.requestId === "string" ? { requestId: wire.requestId } : {}),
    };
  }

  // fetch 自己失败了:离线、DNS、服务没起来。浏览器给的是英文 TypeError。
  if (e instanceof TypeError) {
    return { category: "network", code: "offline", text: "无法连接服务器，请检查网络或确认服务是否在运行", detail: text };
  }

  // 没有分类字段的响应（老版本后端）退回按状态码猜,保持可用。
  const status = (e as { status?: unknown }).status;
  if (typeof status === "number") {
    if (status === 401) return { category: "session", code: "session_expired", text };
    if (status === 403) return { category: "forbidden", code: "forbidden", text };
    if (status >= 500) return { category: "upstream", code: "upstream_http", text };
    return { category: "validation", code: "invalid_request", text };
  }

  return { category: "internal", code: "client_error", text, detail: e instanceof Error ? e.stack : undefined };
}

export type Channel = "inline" | "dialog" | "session";

export function presentation(p: Problem, background = false): Channel {
  if (p.category === "session") return "session";
  if (p.category === "partial" || p.category === "internal") return "dialog";
  // 用户没在等结果的后台请求(挂载时拉 meta)不该拿弹窗糊他一脸
  if (p.category === "upstream" || p.category === "network") return background ? "inline" : "dialog";
  return "inline"; // validation | credentials | forbidden
}

export interface PresentOptions {
  /** 强制走弹窗 —— 给那些页面上没有内联位置的后台动作用。 */
  as?: Channel;
  /** 用户没在等这个结果(挂载时的自动拉取)。 */
  background?: boolean;
  /** 弹窗标题,默认按分类取。 */
  title?: string;
}

const TITLE: Record<Category, string> = {
  validation: "请求有误",
  credentials: "认证失败",
  session: "会话已过期",
  forbidden: "权限不足",
  upstream: "外部服务不可用",
  internal: "出错了",
  partial: "提交中断",
  network: "连接失败",
};

export function raiseDialog(p: Problem, title?: string): void {
  window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: { ...p, title: title ?? TITLE[p.category] } }));
}

/**
 * 统一入口：内联的返回一个 Status 直接塞进现有的槽，弹窗的就地抛出去并返回 null。
 * 调用点因此不必知道规则，只要 `setStatus(presentError(e))`。
 */
export function presentError(e: unknown, opts: PresentOptions = {}): Status | null {
  const p = classify(e);
  const channel = opts.as ?? presentation(p, opts.background);
  if (channel === "inline") return { text: p.text, cls: "error" };
  // session 的弹窗由 App 统一处理(它还要把人送回登录页),这里只负责抛
  raiseDialog(p, opts.title);
  return null;
}
