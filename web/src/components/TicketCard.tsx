/**
 * 单张票的卡片（新拆票与历史继续编辑共用）：已提交只读展示，
 * 草稿态整行控件可编辑。L1 视图：类型无 Epic、指派锁定本人。
 */

import { useMemo } from "react";
import { displayName, isSubmitted, orderedTypes, parentOptionLabel } from "../constants";
import type { Meta, Ticket, User } from "../types";

export function TicketCard({
  t,
  meta,
  user,
  tickets,
  invalid,
  onChange,
  onDelete,
}: {
  t: Ticket;
  meta: Meta;
  user: User;
  /** 本批全部票——父级候选里的「本批」段来自兄弟票。 */
  tickets: Ticket[];
  /** 校验未过的控件名（parent/priority/dueDate/assignee）。 */
  invalid: string[];
  onChange: (patch: Partial<Ticket>) => void;
  onDelete: () => void;
}) {
  const isL1 = user.level === "l1";
  const types = useMemo(() => orderedTypes(meta, user), [meta, user]);

  const parentOptions = useMemo(() => {
    const siblings = tickets
      .filter((s) => s.localId !== t.localId)
      .filter((s) => (t.issueType === "Sub-task" ? s.issueType !== "Sub-task" && s.issueType !== "Epic" : s.issueType === "Epic"))
      .map((s) => ({ label: parentOptionLabel(`本批 ${s.localId}`, s.summary), value: s.localId }));
    const board = (t.issueType === "Sub-task" ? meta.standardParents : meta.epics).map((i) => ({
      label: parentOptionLabel(i.key, i.summary),
      value: i.key,
    }));
    return [...siblings, ...board];
  }, [meta, tickets, t.localId, t.issueType]);

  if (isSubmitted(t)) {
    return (
      <div className="ticket done">
        <div className="head">
          <span className="lid">{t.localId}</span>
          <span className="chip submitted">已提交</span>
          <a className="key" href={t.jiraUrl || "#"} target="_blank" rel="noreferrer">
            {t.jiraKey}
          </a>
        </div>
        <div className="ro-summary" style={{ marginTop: 8 }}>
          {t.summary}
        </div>
        <div className="ro-meta">
          {t.issueType}
          {t.priority ? ` · ${t.priority}` : ""}
          {t.parent ? ` · 父级 ${t.parent}` : ""}
          {t.assignee ? ` · ${displayName(t.assignee, meta.roster)}` : ""}
          {t.startDate ? ` · ${t.startDate} 起` : ""}
          {t.dueDate ? ` · 截止 ${t.dueDate}` : ""}
        </div>
        <details>
          <summary>查看正文</summary>
          <pre>{t.description}</pre>
        </details>
      </div>
    );
  }

  const bad = (f: string) => (invalid.includes(f) ? " invalid" : "");
  const pickType = (v: string) =>
    onChange({ issueType: v, parent: null, ...(v === "Sub-task" ? { priority: null } : {}) });

  return (
    <div className="ticket">
      <div className="head">
        <span className="lid">{t.localId}</span>
        <span className="chip draft">草稿</span>
        <select
          className={("prio " + bad("priority")).trim()}
          disabled={t.issueType === "Sub-task"}
          title={t.issueType === "Sub-task" ? "规范规定 Sub-task 不使用优先级" : "优先级（必填）"}
          value={t.priority ?? ""}
          onChange={(e) => onChange({ priority: e.target.value || null })}
        >
          <option value="">优先级</option>
          {meta.priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="itype" title="类型" value={t.issueType} onChange={(e) => pickType(e.target.value)}>
          {types.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name}
            </option>
          ))}
          {/* 数据里的类型不在可选列表时（如接手他人草稿）保留原值，避免 select 静默改值 */}
          {!types.some((x) => x.name === t.issueType) && <option value={t.issueType}>{t.issueType}</option>}
        </select>
        <select
          className={("parent " + bad("parent")).trim()}
          disabled={t.issueType === "Epic"}
          title={parentOptions.find((o) => o.value === t.parent)?.label ?? "父级（必填）"}
          value={t.parent ?? ""}
          onChange={(e) => onChange({ parent: e.target.value || null })}
        >
          <option value="">父级（必填）</option>
          {parentOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {isL1 ? (
          <select className={("assg " + bad("assignee")).trim()} disabled value={t.assignee ?? user.email} title="低级账号只能指派给本人">
            <option value={user.email}>{user.name}（本人）</option>
          </select>
        ) : (
          <select
            className={("assg " + bad("assignee")).trim()}
            title={displayName(t.assignee, meta.roster) || "指派给"}
            value={t.assignee ?? ""}
            onChange={(e) => onChange({ assignee: e.target.value || null })}
          >
            <option value="">不指派</option>
            {meta.roster.map((m) => (
              <option key={m.email} value={m.email}>
                {m.name}
              </option>
            ))}
            {t.assignee && !meta.roster.some((m) => m.email === t.assignee) && <option value={t.assignee}>{t.assignee}</option>}
          </select>
        )}
        <input
          type="date"
          title="开始日期"
          value={t.startDate ?? ""}
          onChange={(e) => onChange({ startDate: e.target.value || null })}
        />
        <input
          type="date"
          title="截止日期"
          className={bad("dueDate").trim()}
          value={t.dueDate ?? ""}
          onChange={(e) => onChange({ dueDate: e.target.value || null })}
        />
        <button className="danger del" title="删除此票" onClick={onDelete}>
          删除
        </button>
      </div>
      <label>标题</label>
      <input className="f-summary" value={t.summary} onChange={(e) => onChange({ summary: e.target.value })} />
      <label>正文 markdown</label>
      <textarea rows={9} value={t.description} onChange={(e) => onChange({ description: e.target.value })} />
    </div>
  );
}
