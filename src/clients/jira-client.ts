/**
 * Jira Cloud REST v3 client.
 *
 * Same conventions as confluence-client: native fetch, 30s timeout, and
 * per-status errors that tell the user what to do. Jira's structured error
 * bodies ({ errorMessages, errors: { field: msg } }) are folded into thrown
 * messages — that detail is the only way to diagnose required-custom-field
 * failures on create.
 *
 * Auth: shared Atlassian credentials from ./atlassian-auth.js.
 */

import { getAtlassianAuthHeader, getAtlassianBaseUrl } from "./atlassian-auth.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
  description?: string;
}

export interface JiraLinkType {
  name: string;
  inward: string;
  outward: string;
}

export interface ProjectMeta {
  projectKey: string;
  issueTypes: JiraIssueType[];
  /** Priority names (Jira priorities are global, not per-project). */
  priorities: string[];
  linkTypes: JiraLinkType[];
  fetchedAt: string;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function jiraFetch(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const base = getAtlassianBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: getAtlassianAuthHeader(),
      Accept: "application/json",
      ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    if (res.status === 401) {
      throw new Error(
        "Jira rejected the API token (401). Regenerate at id.atlassian.com/manage-profile/security/api-tokens and update ATLASSIAN_API_TOKEN." +
          detail,
      );
    }
    if (res.status === 403) {
      throw new Error(
        `Jira denied access (403) for ${path}. The token's owner needs browse/create permission on the project.` + detail,
      );
    }
    if (res.status === 404) {
      throw new Error(`Jira resource not found (404) for ${path}. Check the project key / issue key.` + detail);
    }
    throw new Error(`Jira API ${path} → HTTP ${res.status}${detail}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts: string[] = [];
    if (body.errorMessages?.length) parts.push(...body.errorMessages);
    if (body.errors) parts.push(...Object.entries(body.errors).map(([field, msg]) => `${field}: ${msg}`));
    return parts.length ? `\nJira says: ${parts.join("; ")}` : "";
  } catch {
    return "";
  }
}

// ─── Project metadata ───────────────────────────────────────────────────────

/**
 * Everything the LLM and the pre-submit checks need to know about the target
 * project. Uses the post-2023 createmeta endpoint (the old full
 * /issue/createmeta is deprecated).
 */
export async function getProjectMeta(projectKey: string): Promise<ProjectMeta> {
  const [typesRes, prioritiesRes, linkTypesRes] = await Promise.all([
    jiraFetch(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=200`),
    jiraFetch(`/rest/api/3/priority/search?maxResults=100`),
    jiraFetch(`/rest/api/3/issueLinkType`),
  ]);

  const rawTypes = (typesRes as { issueTypes?: unknown[]; values?: unknown[] }) ?? {};
  const issueTypes = ((rawTypes.issueTypes ?? rawTypes.values ?? []) as Array<Record<string, unknown>>).map((t) => ({
    id: String(t.id),
    name: String(t.name),
    subtask: Boolean(t.subtask),
    ...(typeof t.hierarchyLevel === "number" ? { hierarchyLevel: t.hierarchyLevel } : {}),
    ...(t.description ? { description: String(t.description) } : {}),
  }));
  if (!issueTypes.length) {
    throw new Error(
      `Jira returned no issue types for project "${projectKey}" — check the key and the token's project permissions`,
    );
  }

  const priorities = (((prioritiesRes as { values?: unknown[] })?.values ?? []) as Array<{ name: string }>).map(
    (p) => p.name,
  );
  const linkTypes = (
    ((linkTypesRes as { issueLinkTypes?: unknown[] })?.issueLinkTypes ?? []) as Array<{
      name: string;
      inward: string;
      outward: string;
    }>
  ).map((l) => ({ name: l.name, inward: l.inward, outward: l.outward }));

  return { projectKey, issueTypes, priorities, linkTypes, fetchedAt: new Date().toISOString() };
}

// ─── Issue search ───────────────────────────────────────────────────────────

export interface JiraIssueSummary {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  parent: string | null;
  labels: string[];
  dueDate: string | null;
  created: string;
  updated: string;
}

interface RawSearchIssue {
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string };
    parent?: { key?: string };
    labels?: string[];
    duedate?: string | null;
    created?: string;
    updated?: string;
  };
}

const SEARCH_FIELDS = "summary,issuetype,status,priority,assignee,parent,labels,duedate,created,updated";

/**
 * Run a JQL search and return every matching issue (trimmed to the fields we
 * care about). Uses the cursor-paginated /search/jql endpoint — the legacy
 * startAt-based /search was retired by Atlassian.
 */
export async function searchIssues(jql: string): Promise<JiraIssueSummary[]> {
  const issues: JiraIssueSummary[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ jql, maxResults: "100", fields: SEARCH_FIELDS });
    if (pageToken) params.set("nextPageToken", pageToken);
    const res = (await jiraFetch(`/rest/api/3/search/jql?${params.toString()}`)) as {
      issues?: RawSearchIssue[];
      nextPageToken?: string;
    };
    for (const it of res.issues ?? []) {
      const f = it.fields ?? {};
      issues.push({
        key: it.key,
        summary: f.summary ?? "",
        issueType: f.issuetype?.name ?? "?",
        status: f.status?.name ?? "?",
        priority: f.priority?.name ?? null,
        assignee: f.assignee?.displayName ?? null,
        parent: f.parent?.key ?? null,
        labels: f.labels ?? [],
        dueDate: f.duedate ?? null,
        created: f.created ?? "",
        updated: f.updated ?? "",
      });
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return issues;
}

// ─── User roster ────────────────────────────────────────────────────────────

export interface JiraUser {
  accountId: string;
  displayName: string;
  /** Null when the user's privacy settings hide it. */
  email: string | null;
}

/**
 * List the site's active human Jira users — deactivated accounts, apps/bots
 * and JSM customers are filtered out.
 */
export async function listUsers(): Promise<JiraUser[]> {
  const users: JiraUser[] = [];
  const pageSize = 200;
  for (let startAt = 0; ; startAt += pageSize) {
    const page = (await jiraFetch(`/rest/api/3/users/search?startAt=${startAt}&maxResults=${pageSize}`)) as Array<{
      accountId: string;
      accountType?: string;
      displayName?: string;
      emailAddress?: string;
      active?: boolean;
    }>;
    if (!page?.length) break;
    for (const u of page) {
      if (u.accountType !== "atlassian" || !u.active) continue;
      users.push({
        accountId: u.accountId,
        displayName: u.displayName ?? "",
        email: u.emailAddress ?? null,
      });
    }
    if (page.length < pageSize) break;
  }
  return users;
}

// ─── User lookup ────────────────────────────────────────────────────────────

/**
 * Resolve a human-entered name/email to an accountId. Requires exactly one
 * active match — ambiguity is an error so a ticket never lands on the wrong
 * person silently.
 */
export async function findUserAccountId(query: string): Promise<string> {
  const res = (await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(query)}`)) as Array<{
    accountId: string;
    displayName: string;
    active: boolean;
  }>;
  const matches = (res ?? []).filter((u) => u.active);
  if (matches.length === 1) return matches[0].accountId;
  if (matches.length === 0) {
    throw new Error(`Jira 找不到用户 "${query}" — 在草稿里换成更准确的姓名或邮箱`);
  }
  throw new Error(
    `Jira 用户 "${query}" 有 ${matches.length} 个匹配（${matches.map((u) => u.displayName).join(", ")}）— 在草稿里用邮箱精确指定`,
  );
}

// ─── Issue creation ─────────────────────────────────────────────────────────

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  /** ADF document (from utils/adf.ts). */
  descriptionAdf: unknown;
  issueTypeName: string;
  priorityName?: string;
  labels?: string[];
  /** Works for both Epic→Story and Task→Sub-task containment in Jira Cloud. */
  parentKey?: string;
  /** From findUserAccountId. */
  assigneeAccountId?: string;
  /** From findUserAccountId. Needs "Modify Reporter" permission on the project. */
  reporterAccountId?: string;
  /** YYYY-MM-DD. */
  dueDate?: string;
  /** Merged last — escape hatch for required custom fields (config.staticFields). */
  extraFields?: Record<string, unknown>;
}

export async function createIssue(input: CreateIssueInput): Promise<{ key: string; id: string; url: string }> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    description: input.descriptionAdf,
    issuetype: { name: input.issueTypeName },
    ...(input.priorityName ? { priority: { name: input.priorityName } } : {}),
    ...(input.labels?.length ? { labels: input.labels } : {}),
    ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
    ...(input.assigneeAccountId ? { assignee: { id: input.assigneeAccountId } } : {}),
    ...(input.reporterAccountId ? { reporter: { id: input.reporterAccountId } } : {}),
    ...(input.dueDate ? { duedate: input.dueDate } : {}),
    ...input.extraFields,
  };
  const res = (await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  })) as { id: string; key: string };
  return { key: res.key, id: res.id, url: `${getAtlassianBaseUrl()}/browse/${res.key}` };
}

/**
 * Link two existing issues. Direction: the outward phrase applies to the
 * outward issue — for type "Blocks" (outward "blocks"), outwardKey blocks
 * inwardKey. Callers pass from=outward, to=inward.
 */
export async function createIssueLink(typeName: string, outwardKey: string, inwardKey: string): Promise<void> {
  await jiraFetch("/rest/api/3/issueLink", {
    method: "POST",
    body: JSON.stringify({
      type: { name: typeName },
      outwardIssue: { key: outwardKey },
      inwardIssue: { key: inwardKey },
    }),
  });
}
