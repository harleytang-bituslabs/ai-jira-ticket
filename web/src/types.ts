/**
 * 前端侧的 API 数据形状。与服务端 zod schema（src/core/schema.ts 等）保持一致，
 * 手工镜像而不跨包 import——避免把服务端依赖拖进浏览器构建。
 */

export type UserLevel = "l1" | "l2" | "admin";

export interface User {
  email: string;
  name: string;
  level: UserLevel;
  /** 可见 board 的 projectKey；admin 恒定可见全部，此列表可能为空。 */
  boards: string[];
  /** 纯展示标签，不参与权限。 */
  team: string | null;
}

export interface Ticket {
  localId: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  parent: string | null;
  assignee: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimate: string | null;
  jiraKey?: string;
  jiraUrl?: string;
}

export interface DraftLink {
  from: string;
  to: string;
  type: string;
  created: boolean;
}

export interface DraftFile {
  meta: {
    version: 1;
    createdAt: string;
    input: string;
    projectKey: string;
    specSyncedAt: string | null;
    specVersions: Array<number | null>;
    model: string;
  };
  tickets: Ticket[];
  links: DraftLink[];
  notes: string | null;
}

/** 编辑器/历史里的一条记录（历史即草稿档案）。 */
export interface DraftEntry {
  id: string;
  owner: string;
  draft: DraftFile;
}

export interface IssueRef {
  key: string;
  summary: string;
  status: string;
  /** Story/Task 所属 Epic 的 key——Sub-task 父级二级联动用。 */
  parent: string | null;
}

export interface RosterMember {
  name: string;
  email: string;
}

export interface Meta {
  projectKey: string;
  issueTypes: Array<{ name: string; subtask: boolean }>;
  priorities: string[];
  epics: IssueRef[];
  standardParents: IssueRef[];
  roster: RosterMember[];
  /** 「更新config」刷新的三份参考数据各自的时间；规范缓存可能还没建立。 */
  specSyncedAt: string | null;
  issuesFetchedAt: string;
  rosterFetchedAt: string | null;
}

export interface AdminUser {
  email: string;
  name: string;
  level: UserLevel;
  boards: string[];
  team: string | null;
  active: boolean;
  createdAt: string;
}
