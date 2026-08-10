/**
 * 只在 HTTP 边界打桩(网络是无法避免的边界),分页与过滤逻辑跑的是真代码。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAssignableUsers } from "../src/clients/jira-client.js";

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

describe("listAssignableUsers", () => {
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

  const stub = (pages: unknown[][]): void => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(pages[call++] ?? []);
    }) as unknown as typeof fetch;
  };

  it("asks Jira for the project's assignable users, not the whole site", async () => {
    stub([[jiraUser(1)]]);
    await listAssignableUsers("AIP");
    expect(urls[0]).toContain("/rest/api/3/user/assignable/search");
    expect(urls[0]).toContain("project=AIP");
    // 全站名册接口正是「闲杂人等」的根因,不该再被碰
    expect(urls[0]).not.toContain("/users/search");
  });

  it("pages until Jira returns a short page", async () => {
    const full = Array.from({ length: 200 }, (_, i) => jiraUser(i));
    stub([full, [jiraUser(900), jiraUser(901)]]);
    const users = await listAssignableUsers("AIP");
    expect(users.length).toBe(202);
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain("startAt=200");
  });

  it("drops apps, JSM customers and deactivated accounts", async () => {
    stub([
      [
        jiraUser(1),
        jiraUser(2, { accountType: "app" }),
        jiraUser(3, { accountType: "customer" }),
        jiraUser(4, { active: false }),
      ],
    ]);
    const users = await listAssignableUsers("AIP");
    expect(users.map((u) => u.accountId)).toEqual(["acc-1"]);
  });

  it("keeps users whose privacy settings hide the email", async () => {
    stub([[jiraUser(1, { emailAddress: undefined })]]);
    const users = await listAssignableUsers("AIP");
    expect(users[0]).toMatchObject({ accountId: "acc-1", displayName: "User 1", email: null });
  });

  it("url-encodes the project key", async () => {
    stub([[]]);
    await listAssignableUsers("A B&C");
    expect(urls[0]).toContain("project=A%20B%26C");
  });
});
