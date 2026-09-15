/**
 * 错误分类与状态码映射。errorHandler 是纯函数,用桩 req/res 直接调,不起 app。
 *
 * 本文件的头号断言是「上游的 401 绝不会变成我们的 401」—— 那正是 API key 失效
 * 时把用户踢回登录页的那条路径。
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden, internal, invalid, partial, sessionError, upstream } from "../src/core/errors.js";
import { errorHandler, HttpError, toAppError, type WireError } from "../src/server/middlewares/error.js";

interface Captured {
  status: number;
  body: WireError;
}

/** 跑一遍完整的 errorHandler,拿到它实际会发出的状态码与响应体。 */
function handle(err: unknown, req: Partial<Request> = {}): Captured {
  const out = { status: 0, body: {} as WireError };
  const res = {
    setHeader: () => res,
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: WireError) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  const fullReq = { method: "POST", originalUrl: "/api/draft", id: "testid00", ...req } as Request;
  errorHandler(err, fullReq, res, (() => {}) as never);
  return out;
}

describe("errorHandler — 上游状态码的围堵", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("回归锚点:Anthropic 形状的 401 变成 502/upstream,绝不回 401", () => {
    // @anthropic-ai/sdk 的 APIError:顶层 status,就是这个字段被原样透传过
    const apiError = Object.assign(new Error("401 authentication_error: invalid x-api-key"), { status: 401 });
    const r = handle(apiError);
    expect(r.status).toBe(502);
    expect(r.body.category).toBe("upstream");
    expect(r.body.code).toBe("upstream_http");
  });

  it("上游 403 同样不会变成我们的 403", () => {
    const r = handle(Object.assign(new Error("permission denied"), { status: 403 }));
    expect(r.status).toBe(502);
    expect(r.body.category).toBe("upstream");
  });

  it("AWS 的嵌套 $metadata 被识别为存储不可用,原文只进 detail", () => {
    const awsErr = Object.assign(new Error("Access Denied: bituslabs-ai-jira-ticket/users.json"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const r = handle(awsErr);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("storage_unavailable");
    expect(r.body.error).not.toContain("bituslabs-ai-jira-ticket"); // 桶名不进用户可见文案
  });

  it("超时归 upstream/504", () => {
    const t = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(handle(t).status).toBe(504);
    expect(handle(t).body.code).toBe("upstream_timeout");
  });

  it("fetch 失败归 upstream 而非用户输入错误", () => {
    const r = handle(new TypeError("fetch failed"));
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("upstream_unreachable");
  });
});

describe("errorHandler — 分类到状态码", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("各分类映射到约定状态码", () => {
    expect(handle(invalid("invalid_request", "x")).status).toBe(400);
    expect(handle(sessionError("session_expired", "x")).status).toBe(401);
    expect(handle(forbidden("admin_required", "x")).status).toBe(403);
    expect(handle(internal("boom", "x")).status).toBe(500);
    expect(handle(upstream("anthropic_auth", "x")).status).toBe(502);
  });

  it("code 可以覆写分类的默认状态码", () => {
    expect(handle(invalid("draft_not_found", "草稿不存在")).status).toBe(404);
    expect(handle(invalid("account_exists", "已存在")).status).toBe(409);
    expect(handle(invalid("rate_limit", "太多了")).status).toBe(429);
    expect(handle(upstream("atlassian_unavailable", "Jira 挂了")).status).toBe(503);
  });

  it("HttpError 沿用旧签名,自动带上分类", () => {
    const r = handle(new HttpError(403, "你没有开票权限"));
    expect(r.status).toBe(403);
    expect(r.body.category).toBe("forbidden");
    expect(r.body.error).toBe("你没有开票权限");
  });

  it("partial 携带恢复载荷,状态码 409", () => {
    const recovery = { id: "d1", draft: { tickets: [] }, created: 2, total: 5 };
    const r = handle(partial("提交在创建 2/5 张票后中断", recovery));
    expect(r.status).toBe(409);
    expect(r.body.category).toBe("partial");
    expect(r.body.recovery).toEqual(recovery);
  });

  it("ZodError 不再把 JSON blob 丢给用户", () => {
    const zod = Object.assign(new Error("[{\"code\":\"invalid_type\"}]"), {
      name: "ZodError",
      issues: [{ path: ["tickets", 0, "summary"], message: "Required" }],
    });
    const r = handle(zod);
    expect(r.status).toBe(400);
    expect(r.body.error).not.toContain('[{"code"');
    expect(r.body.detail).toContain("tickets.0.summary: Required");
  });

  it("body-parser 的 type 优先于它自带的 status", () => {
    expect(handle(Object.assign(new Error("bad json"), { type: "entity.parse.failed", status: 400 })).status).toBe(400);
    expect(handle(Object.assign(new Error("too big"), { type: "entity.too.large", status: 413 })).status).toBe(413);
  });

  it("未分类的普通 Error 维持 400,文案原样(暂不改变现有行为)", () => {
    const r = handle(new Error("input 不能为空"));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("unclassified");
    expect(r.body.error).toBe("input 不能为空");
  });

  it("响应体带上与日志同号的排查码", () => {
    expect(handle(invalid("x", "y"), { id: "deadbeef" }).body.requestId).toBe("deadbeef");
  });
});

describe("日志", () => {
  afterEach(() => vi.restoreAllMocks());

  it("upstream/internal 走 console.error 并带堆栈", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle(upstream("anthropic_auth", "AI 服务认证失败"));
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.join(" "))).toContain("upstream/anthropic_auth");
  });

  it("未分类的错误以 warn 出现,不会静悄悄混在用户错误里", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle(new Error("某处漏网的抛出"));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("unclassified");
  });

  it("普通校验错误只记 info,不记堆栈", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle(invalid("weak_password", "新密码至少 8 位"));
    expect(info).toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("toAppError 幂等", () => {
  it("已经是 AppError 的原样返回", () => {
    const e = upstream("anthropic_auth", "x", { detail: "401" });
    expect(toAppError(e)).toBe(e);
  });
});
