/**
 * 开票历史（历史即草稿档案）：admin 看全员（带所有者列/筛选），其他人只看自己。
 * 筛选在已鉴权的数据集上前端过滤：时间起止 / 父级 / 指派（L2+admin）/ 提交状态 / 所有者（admin）。
 * admin 可删除任何人的记录，但「继续编辑」只对自己的草稿开放。
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { presentError } from "../errors";
import { displayName, isSubmitted } from "../constants";
import type { DraftEntry, RosterMember, User } from "../types";

interface Filters {
  from: string;
  to: string;
  parent: string;
  assignee: string;
  status: "" | "hasDraft" | "allDone";
  owner: string;
}

const EMPTY: Filters = { from: "", to: "", parent: "", assignee: "", status: "", owner: "" };

export function HistoryView({
  user,
  roster,
  currentId,
  onEdit,
  onDeletedCurrent,
}: {
  user: User;
  roster: RosterMember[];
  currentId: string | null;
  onEdit: (entry: DraftEntry) => void;
  onDeletedCurrent: () => void;
}) {
  const isAdmin = user.level === "admin";
  const [entries, setEntries] = useState<DraftEntry[] | null>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState<Filters>(EMPTY);

  const load = () => {
    api<{ drafts: DraftEntry[] }>("GET", isAdmin ? "/api/drafts?scope=all" : "/api/drafts")
      .then((d) => {
        setErr(""); // 成功要清掉上一次的错误,否则加载好了页面上还挂着旧报错
        setEntries([...d.drafts].sort((a, b) => b.draft.meta.createdAt.localeCompare(a.draft.meta.createdAt)));
      })
      .catch((e) => setErr(presentError(e)?.text ?? ""));
  };
  useEffect(load, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // 筛选候选项从数据聚合
  const options = useMemo(() => {
    const parents = new Set<string>();
    const assignees = new Set<string>();
    const owners = new Set<string>();
    for (const e of entries ?? []) {
      owners.add(e.owner);
      for (const t of e.draft.tickets) {
        if (t.parent) parents.add(t.parent);
        if (t.assignee) assignees.add(t.assignee);
      }
    }
    return { parents: [...parents].sort(), assignees: [...assignees].sort(), owners: [...owners].sort() };
  }, [entries]);

  const shown = useMemo(
    () =>
      (entries ?? []).filter((e) => {
        const day = e.draft.meta.createdAt.slice(0, 10);
        if (f.from && day < f.from) return false;
        if (f.to && day > f.to) return false;
        if (f.parent && !e.draft.tickets.some((t) => t.parent === f.parent)) return false;
        if (f.assignee && !e.draft.tickets.some((t) => t.assignee === f.assignee)) return false;
        if (f.status === "hasDraft" && e.draft.tickets.every(isSubmitted)) return false;
        if (f.status === "allDone" && !e.draft.tickets.every(isSubmitted)) return false;
        if (f.owner && e.owner !== f.owner) return false;
        return true;
      }),
    [entries, f],
  );

  const del = async (e: DraftEntry) => {
    const mine = e.owner === user.email;
    if (!confirm(mine ? "删除这条本地记录？已上板的 Jira 票不受影响。" : `删除 ${e.owner} 的这条记录？已上板的 Jira 票不受影响。`)) return;
    const q = mine ? "" : `?owner=${encodeURIComponent(e.owner)}`;
    await api("DELETE", `/api/drafts/${encodeURIComponent(e.id)}${q}`);
    if (currentId === e.id && mine) onDeletedCurrent();
    load();
  };

  const cleanup = async () => {
    if (!confirm("将删除你自己所有票都已提交的本地记录（不影响 Jira 上的票）。继续？")) return;
    const { removed } = await api<{ removed: number }>("POST", "/api/drafts/cleanup");
    alert(`已清理 ${removed} 条记录`);
    load();
  };

  const showAssigneeFilter = user.level !== "l1";
  const filtering = f !== EMPTY && Object.values(f).some(Boolean);

  return (
    <div>
      <div className="filterbar">
        <div className="fgroup">
          <label>从</label>
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </div>
        <div className="fgroup">
          <label>到</label>
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <div className="fgroup">
          <label>父级</label>
          <select value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })}>
            <option value="">全部</option>
            {options.parents.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {showAssigneeFilter && (
          <div className="fgroup">
            <label>指派</label>
            <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">全部</option>
              {options.assignees.map((a) => (
                <option key={a} value={a}>
                  {displayName(a, roster)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="fgroup">
          <label>状态</label>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Filters["status"] })}>
            <option value="">全部</option>
            <option value="hasDraft">含草稿</option>
            <option value="allDone">全部已提交</option>
          </select>
        </div>
        {isAdmin && (
          <div className="fgroup">
            <label>所有者</label>
            <select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
              <option value="">全部</option>
              {options.owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        )}
        {filtering && (
          <button className="ghost clear" onClick={() => setF(EMPTY)}>
            清除筛选
          </button>
        )}
      </div>

      <div className="toolbar">
        <button className="ghost" onClick={() => void cleanup()}>
          清理已完结
        </button>
        <span className="hint">删除你自己所有票都已提交的记录；只动档案，不影响 Jira 上的票</span>
        {entries && (
          <span className="hint" style={{ marginLeft: "auto" }}>
            {shown.length} / {entries.length} 条
          </span>
        )}
      </div>

      {/* 以前这里用 .empty(灰字居中),读起来像「没有记录」而不是「加载失败」 */}
      {err && <div className="status error loadErr">{err}</div>}
      {!err && entries === null && <div className="empty">加载中…</div>}
      {entries?.length === 0 && <div className="empty">还没有开票记录</div>}
      {entries && entries.length > 0 && shown.length === 0 && <div className="empty">没有匹配筛选条件的记录</div>}

      {shown.map((entry) => {
        const d = entry.draft;
        const submitted = d.tickets.filter(isSubmitted).length;
        const mine = entry.owner === user.email;
        return (
          <div className="hist" key={`${entry.owner}/${entry.id}`}>
            <div className="top">
              <span className="when">{new Date(d.meta.createdAt).toLocaleString()}</span>
              {isAdmin && <span className="chip owner">{mine ? "我" : entry.owner}</span>}
              <span className="input-excerpt">
                {d.meta.input.slice(0, 80)}
                {d.meta.input.length > 80 ? "…" : ""}
              </span>
              <span className="hint">
                {d.tickets.length} 张 · {submitted} 已提交
              </span>
            </div>
            <div>
              {d.tickets.map((t) => (
                <div className="trow" key={t.localId}>
                  {isSubmitted(t) ? (
                    <>
                      <span className="chip submitted">已提交</span>
                      <span className="sum">{t.summary}</span>
                      <a href={t.jiraUrl || "#"} target="_blank" rel="noreferrer">
                        {t.jiraKey}
                      </a>
                    </>
                  ) : (
                    <>
                      <span className="chip draft">草稿</span>
                      <span className="sum">{t.summary}</span>
                      <span className="hint">
                        {displayName(t.assignee, roster)}
                        {t.dueDate ? ` · ${t.dueDate}` : ""}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="actions">
              {mine && (
                <button className="ghost" onClick={() => onEdit(entry)}>
                  继续编辑
                </button>
              )}
              <button className="danger" onClick={() => void del(entry)}>
                删除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
