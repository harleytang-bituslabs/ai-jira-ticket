/** 提交防呆：列出即将上板的每张票（类型/标题/指派/日期）+ 总数，确认才调 API。 */

import { displayName } from "../constants";
import type { RosterMember, Ticket } from "../types";

export function ConfirmDialog({
  tickets,
  roster,
  busy,
  onConfirm,
  onCancel,
}: {
  tickets: Ticket[];
  roster: RosterMember[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>确认提交到 Jira</h2>
        <div className="sub">
          即将创建 <b>{tickets.length}</b> 张票，创建后不可在本工具撤销（需去 Jira 处理）：
        </div>
        {tickets.map((t) => (
          <div className="mrow" key={t.localId}>
            <span className="chip draft">{t.issueType}</span>
            <span className="sum">{t.summary}</span>
            <span className="meta">
              {displayName(t.assignee, roster) || "不指派"}
              {t.startDate ? ` · ${t.startDate} 起` : ""}
              {t.dueDate ? ` · 截止 ${t.dueDate}` : ""}
            </span>
          </div>
        ))}
        <div className="mfoot">
          <button className="ghost" disabled={busy} onClick={onCancel}>
            再改改
          </button>
          <button className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? "提交中…" : `确认提交 ${tickets.length} 张`}
          </button>
        </div>
      </div>
    </div>
  );
}
