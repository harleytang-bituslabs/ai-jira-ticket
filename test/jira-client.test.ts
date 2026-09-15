/**
 * 只在 HTTP 边界打桩(网络是无法避免的边界),分页与过滤逻辑跑的是真代码。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError, type AppError } from "../src/core/errors.js";
import { listProjectParticipants, listProjects } from "../src/clients/jira-client.js";

const realFetch = globalThis.fetch;

/** 造一个 Jira 用户对象;默认是可指派的活人。 */
const jiraUser = (n: number, over: Record<string, unknown> = {}) => ({
  accountId: `acc-${n}`,
  accountType: "atlassian",
  displayName: `User ${n}`,
  emailAddress: `u${n}@example.com`,
  active: true,
  ...over,
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("listProjectParticipants", () => {
  let urls: string[];

  beforeEach(() => {
    process.env.ATLASSIAN_BASE_URL = "https://example.atlassian.net";
    process.env.ATLASSIAN_EMAIL = "bot@example.com";
    process.env.ATLASSIAN_API_TOKEN = "token";
    urls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** 每个 page 是一批 issue 的 fields;最后一页不带 nextPageToken。 */
  const stubIssues = (pages: Array<Array<Record<string, unknown>>>): void => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      const i = call++;
      const body: Record<string, unknown> = { issues: (pages[i] ?? []).map((fields, n) => ({ key: `X-${i}-${n}`, fields })) };
      if (i < pages.length - 1) body.nextPageToken = `tok-${i}`;
      return jsonResponse(body);
    }) as unknown as typeof fetch;
  };

  it("collects both assignees and reporters, deduped by accountId", async () => {
    stubIssues([
      [
        { assignee: jiraUser(1), reporter: jiraUser(2) },
        { assignee: jiraUser(1), reporter: jiraUser(3) }, // 1 重复出现
      ],
    ]);
    const users = await listProjectParticipants("AIP");
    expect(users.map((u) => u.accountId).sort()).toEqual(["acc-1", "acc-2", "acc-3"]);
  });

  /** 按 query-string 规则解码:URLSearchParams 会把空格编码成 "+"。 */
  const readUrl = (u: string): string => decodeURIComponent(u.replace(/\+/g, "%20"));

  it("asks only for the two people fields, scoped by JQL to the project", async () => {
    stubIssues([[]]);
    await listProjectParticipants("AIP");
    const u = readUrl(urls[0]);
    expect(u).toContain("/rest/api/3/search/jql");
    expect(u).toContain('project = "AIP"');
    expect(u).toContain("fields=assignee,reporter");
  });

  it("follows nextPageToken to the last page", async () => {
    stubIssues([[{ assignee: jiraUser(1) }], [{ assignee: jiraUser(2) }], [{ assignee: jiraUser(3) }]]);
    const users = await listProjectParticipants("AIP");
    expect(users.length).toBe(3);
    expect(urls.length).toBe(3);
    expect(readUrl(urls[2])).toContain("nextPageToken=tok-1");
  });

  it("tolerates unassigned issues and missing reporters", async () => {
    stubIssues([[{ assignee: null }, { reporter: jiraUser(9) }, {}]]);
    const users = await listProjectParticipants("AIP");
    expect(users.map((u) => u.accountId)).toEqual(["acc-9"]);
  });

  it("drops apps and deactivated accounts here too", async () => {
    stubIssues([[{ assignee: jiraUser(1, { accountType: "app" }) }, { assignee: jiraUser(2, { active: false }) }, { assignee: jiraUser(3) }]]);
    const users = await listProjectParticipants("AIP");
    expect(users.map((u) => u.accountId)).toEqual(["acc-3"]);
  });

  it("keeps a participant whose email is hidden by privacy settings", async () => {
    stubIssues([[{ assignee: jiraUser(1, { emailAddress: undefined }) }]]);
    const users = await listProjectParticipants("AIP");
    expect(users[0]).toMatchObject({ accountId: "acc-1", email: null });
  });

  it("quotes the project key so odd keys can't break the JQL", async () => {
    stubIssues([[]]);
    await listProjectParticipants("A B");
    expect(readUrl(urls[0])).toContain('project = "A B"');
  });
});

describe("listProjects", () => {
  let urls: string[];

  beforeEach(() => {
    process.env.ATLASSIAN_BASE_URL = "https://example.atlassian.net";
    process.env.ATLASSIAN_EMAIL = "bot@example.com";
    process.env.ATLASSIAN_API_TOKEN = "token";
    urls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** /project/search 的分页信封:values + isLast。 */
  const stubPages = (pages: Array<Array<{ key: string; name: string }>>): void => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      const i = call++;
      return jsonResponse({ values: pages[i] ?? [], isLast: i >= pages.length - 1 });
    }) as unknown as typeof fetch;
  };

  it("returns every project's key and name", async () => {
    stubPages([[{ key: "AIP", name: "AI Pipeline" }, { key: "CG", name: "Casual Games" }]]);
    const projects = await listProjects();
    expect(projects).toEqual([
      { key: "AIP", name: "AI Pipeline" },
      { key: "CG", name: "Casual Games" },
    ]);
    expect(urls[0]).toContain("/rest/api/3/project/search");
  });

  it("pages until isLast", async () => {
    stubPages([[{ key: "A", name: "A" }], [{ key: "B", name: "B" }]]);
    const projects = await listProjects();
    expect(projects.map((p) => p.key)).toEqual(["A", "B"]);
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain("startAt=1");
  });
});

describe("Atlassian 错误的分类与脱敏", () => {
  beforeEach(() => {
    process.env.ATLASSIAN_BASE_URL = "https://example.atlassian.net";
    process.env.ATLASSIAN_EMAIL = "bot@example.com";
    process.env.ATLASSIAN_API_TOKEN = "token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const stubStatus = (status: number, body: unknown = {}): void => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
  };

  it("上游 401 归 upstream —— 我们的令牌被拒从来不是用户的问题", async () => {
    stubStatus(401, { errorMessages: ["Client must be authenticated"] });
    const err = await listProjects().catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).category).toBe("upstream");
    expect((err as AppError).code).toBe("atlassian_auth");
  });

  it("补救指引进 detail,不进用户看到的那句话", async () => {
    stubStatus(401, {});
    const err = (await listProjects().catch((e: unknown) => e)) as AppError;
    expect(err.message).not.toContain("id.atlassian.com");
    expect(err.message).not.toContain("ATLASSIAN_API_TOKEN");
    expect(err.detail).toContain("id.atlassian.com");
  });

  it("5xx 归 upstream/atlassian_unavailable,原始响应体不进标题", async () => {
    stubStatus(503, { html: "<html>gateway down</html>" });
    const err = (await listProjects().catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("atlassian_unavailable");
    expect(err.message).not.toContain("gateway down");
    expect(err.detail).toContain("gateway down");
  });

  it("400 的字段级报错是用户能处理的,留在标题里", async () => {
    stubStatus(400, { errors: { customfield_10015: "Field cannot be set" } });
    const err = (await listProjects().catch((e: unknown) => e)) as AppError;
    expect(err.category).toBe("validation");
    expect(err.message).toContain("customfield_10015");
  });

  it("网络层失败归 upstream 而不是用户输入错误", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const err = (await listProjects().catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("upstream_timeout");
  });
});
