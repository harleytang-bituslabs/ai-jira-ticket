/**
 * 只在 HTTP 边界打桩(网络是无法避免的边界),分页与过滤逻辑跑的是真代码。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
