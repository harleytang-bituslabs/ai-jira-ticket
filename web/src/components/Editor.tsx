/**
 * 草稿编辑区：卡片列表 + 关联 chips + AI 说明 + 保存/提交。
 * 提交流程：必填校验（未过→红框+文案）→ 确认弹窗 → 保存 → 提交。
 * 提交是断点续传式的：部分失败时服务端回最新落盘状态，这里原样恢复继续改。
 */

import { useState } from "react";
import { ApiError, api, errMsg } from "../api";
import { FIELD_TO_CONTROL, isSubmitted, missingFields } from "../constants";
import type { DraftEntry, DraftFile, Meta, Ticket, User } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { TicketCard } from "./TicketCard";

type Status = { text: string; cls?: "ok" | "error" };

export function Editor({
  meta,
  user,
  current,
  setCurrent,
  onRecordDeleted,
}: {
  meta: Meta;
  user: User;
  current: DraftEntry | null;
  setCurrent: (e: DraftEntry | null) => void;
  onRecordDeleted: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string[]>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!current) return null;
  const draft = current.draft;

  const patchDraft = (up: (d: DraftFile) => DraftFile) => setCurrent({ ...current, draft: up(draft) });

  const updateTicket = (localId: string, patch: Partial<Ticket>) => {
    patchDraft((d) => ({ ...d, tickets: d.tickets.map((t) => (t.localId === localId ? { ...t, ...patch } : t)) }));
    // 改过的控件即时撤红框
    const touched = Object.keys(patch);
    setInvalid((m) => {
      const cur = m[localId];
      if (!cur) return m;
      const left = cur.filter((f) => !touched.includes(f));
      return { ...m, [localId]: left };
    });
  };

  const deleteTicket = async (t: Ticket) => {
    if (draft.tickets.length === 1) {
      if (!confirm("这是最后一张票——将删除整条草稿记录（不影响 Jira）。确定？")) return;
      await api("DELETE", `/api/drafts/${encodeURIComponent(current.id)}`);
      onRecordDeleted();
      return;
    }
    patchDraft((d) => ({
      ...d,
      tickets: d.tickets.map((x) => (x.parent === t.localId ? { ...x, parent: null } : x)).filter((x) => x.localId !== t.localId),
      links: d.links.filter((l) => l.from !== t.localId && l.to !== t.localId),
    }));
  };

  const save = async (): Promise<DraftEntry> => {
    const data = await api<{ id: string; draft: DraftFile }>("PUT", `/api/drafts/${encodeURIComponent(current.id)}`, { draft });
    const entry = { ...current, draft: data.draft };
    setCurrent(entry);
    return entry;
  };

  const onSave = async () => {
    try {
      await save();
      setStatus({ text: "已保存", cls: "ok" });
    } catch (e) {
      setStatus({ text: errMsg(e), cls: "error" });
    }
  };

  /** 提交前校验：返回问题列表并标红缺失控件。 */
  const validate = (): string[] => {
    const problems: string[] = [];
    const marks: Record<string, string[]> = {};
    for (const t of draft.tickets) {
      if (isSubmitted(t)) continue;
      const miss = missingFields(t);
      if (!miss.length) continue;
      problems.push(`${t.localId} 缺: ${miss.join("、")}`);
      marks[t.localId] = miss.map((m) => FIELD_TO_CONTROL[m]!);
    }
    setInvalid(marks);
    return problems;
  };

  const onSubmitClick = () => {
    const problems = validate();
    if (problems.length) {
      setStatus({ text: `请补齐必填字段 — ${problems.join("；")}`, cls: "error" });
      return;
    }
    setConfirmOpen(true);
  };

  const doSubmit = async () => {
    setBusy(true);
    setStatus({ text: "保存并提交中…" });
    try {
      await save();
      const data = await api<{ id: string; draft: DraftFile }>("POST", `/api/drafts/${encodeURIComponent(current.id)}/submit`);
      setCurrent({ ...current, draft: data.draft });
      const keys = data.draft.tickets.map((t) => t.jiraKey).filter(Boolean);
      setStatus({ text: `✓ 全部上板: ${keys.join("  ")}`, cls: "ok" });
      setConfirmOpen(false);
    } catch (e) {
      // 部分进度已落盘：恢复服务端最新状态（已建的票变只读），错误原样展示
      if (e instanceof ApiError && e.data.draft) {
        setCurrent({ ...current, id: (e.data.id as string) ?? current.id, draft: e.data.draft as DraftFile });
      }
      setStatus({ text: errMsg(e), cls: "error" });
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const allDone = draft.tickets.every(isSubmitted);
  const pending = draft.tickets.filter((t) => !isSubmitted(t));

  return (
    <div>
      {draft.tickets.map((t) => (
        <TicketCard
          key={t.localId}
          t={t}
          meta={meta}
          user={user}
          tickets={draft.tickets}
          invalid={invalid[t.localId] ?? []}
          onChange={(patch) => updateTicket(t.localId, patch)}
          onDelete={() => void deleteTicket(t)}
        />
      ))}
      <div>
        {draft.links.map((l, i) => (
          <span className="linkchip" key={`${l.from}-${l.type}-${l.to}-${i}`}>
            {l.from} <b>{l.type}</b> {l.to}
            {l.created ? " ✓" : ""}
            {!l.created && (
              <button title="删除该关联" onClick={() => patchDraft((d) => ({ ...d, links: d.links.filter((q) => q !== l) }))}>
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
      {draft.notes && <div className="hint">AI 说明: {draft.notes}</div>}
      <div className="toolbar">
        <button className="ghost" disabled={allDone || busy} onClick={onSave}>
          保存草稿
        </button>
        <button className="primary" disabled={allDone || busy} onClick={onSubmitClick}>
          提交到 Jira
        </button>
        <span className={"status" + (status?.cls ? " " + status.cls : "")}>{status?.text ?? ""}</span>
      </div>
      {confirmOpen && <ConfirmDialog tickets={pending} busy={busy} onConfirm={() => void doSubmit()} onCancel={() => setConfirmOpen(false)} />}
    </div>
  );
}
