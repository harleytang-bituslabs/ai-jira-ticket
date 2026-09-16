/**
 * 呈现规则的单测。classify/presentation 是纯函数,所以不需要 jsdom ——
 * 会悄悄腐烂的正是这段判定逻辑,渲染用眼睛验。
 */

import { describe, expect, it } from "vitest";
import { classify, presentation, type Category, type Problem } from "./errors";

/** 造一个 api.ts 会抛出的那种错误对象。 */
const apiErr = (category: string, code: string, text = "boom", extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(text), { wire: { category, code, ...extra } });

const problem = (category: Category): Problem => ({ category, code: "x", text: "boom" });

describe("classify", () => {
  it("采信服务端给的分类", () => {
    const p = classify(apiErr("upstream", "anthropic_auth", "AI 服务认证失败", { detail: "HTTP 401", requestId: "a1b2c3d4" }));
    expect(p.category).toBe("upstream");
    expect(p.code).toBe("anthropic_auth");
    expect(p.detail).toBe("HTTP 401");
    expect(p.requestId).toBe("a1b2c3d4");
  });

  it("不认识的分类不采信,退回 internal 而不是当成会话问题", () => {
    expect(classify(apiErr("teleport", "weird")).category).toBe("internal");
  });

  it("fetch 自己失败 → network,并换成中文", () => {
    const p = classify(new TypeError("Failed to fetch"));
    expect(p.category).toBe("network");
    expect(p.text).toContain("无法连接服务器");
  });

  it("没有分类字段的老响应退回按状态码猜", () => {
    expect(classify(Object.assign(new Error("x"), { status: 401 })).category).toBe("session");
    expect(classify(Object.assign(new Error("x"), { status: 403 })).category).toBe("forbidden");
    expect(classify(Object.assign(new Error("x"), { status: 502 })).category).toBe("upstream");
    expect(classify(Object.assign(new Error("x"), { status: 400 })).category).toBe("validation");
  });
});

describe("presentation —— 谁该弹窗", () => {
  it("不可逆或会被销毁的信息走弹窗", () => {
    expect(presentation(problem("partial"))).toBe("dialog");
    expect(presentation(problem("internal"))).toBe("dialog");
    expect(presentation(problem("upstream"))).toBe("dialog");
    expect(presentation(problem("network"))).toBe("dialog");
  });

  it("就地可改的留在原地", () => {
    expect(presentation(problem("validation"))).toBe("inline");
    expect(presentation(problem("forbidden"))).toBe("inline");
  });

  it("回归:API key 失效不再被当成会话问题", () => {
    const p = classify(apiErr("upstream", "anthropic_auth"));
    expect(presentation(p)).toBe("dialog");
    expect(presentation(p)).not.toBe("session");
  });

  it("回归:输错旧密码是 credentials,内联,不碰会话", () => {
    const p = classify(apiErr("credentials", "bad_credentials", "旧密码不正确"));
    expect(presentation(p)).toBe("inline");
  });

  it("只有 session 才把人送回登录页", () => {
    expect(presentation(problem("session"))).toBe("session");
  });

  it("后台自动拉取失败不弹窗糊脸", () => {
    expect(presentation(problem("upstream"), true)).toBe("inline");
    expect(presentation(problem("network"), true)).toBe("inline");
  });

  it("每个分类都有归属,没有漏网的", () => {
    const all: Category[] = [
      "validation",
      "credentials",
      "session",
      "forbidden",
      "upstream",
      "internal",
      "partial",
      "network",
    ];
    for (const c of all) expect(["inline", "dialog", "session"]).toContain(presentation(problem(c)));
  });
});
