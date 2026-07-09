/**
 * 开票表单：前置字段（优先级/类型/父级/指派/截止）+ 需求描述 + 拆票方式。
 * 等价迁移 1.x 的交互：值级配色 seg、Sub-task 父级二级联动、开票前强制必填。
 * 2.0 差异：L1 无类型 Epic、指派锁定本人；指派名册超过 8 人时换可搜索输入框。
 */

import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { orderedTypes, PRIORITY_COLORS, TYPE_COLORS } from "../constants";
import type { Flash } from "../pages/MainPage";
import type { DraftEntry, DraftFile, Meta, User } from "../types";
import { Seg } from "./Seg";

type Status = { text: string; cls?: "ok" | "error" };

export function ComposeForm({
  meta,
  user,
  input,
  setInput,
  flash,
  onReloadMeta,
  onDrafted,
}: {
  meta: Meta;
  user: User;
  input: string;
  setInput: (v: string) => void;
  flash: Flash;
  onReloadMeta: () => Promise<void>;
  onDrafted: (entry: DraftEntry) => void;
}) {
  const types = useMemo(() => orderedTypes(meta, user), [meta, user]);
  const isL1 = user.level === "l1";

  const [type, setType] = useState("Task");
  const [priority, setPriority] = useState<string | null>("P2");
  const [parentEpic, setParentEpic] = useState("");
  const [parent, setParent] = useState("");
  const [assignee, setAssignee] = useState<string | null>(isL1 ? user.jiraEmail : null);
  const [assigneeText, setAssigneeText] = useState(""); // 大名册模式下输入框的显示文本
  const [dueDate, setDueDate] = useState("");
  const [splitMode, setSplitMode] = useState<"" | "1" | "n">("");
  const [splitN, setSplitN] = useState(2);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  // meta 变化（更新config）后收敛非法选中值
  useEffect(() => {
    if (!types.some((t) => t.name === type)) setType(types[0]?.name ?? "Task");
    if (priority && !meta.priorities.includes(priority)) setPriority(meta.priorities[0] ?? null);
  }, [meta, types]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearMark = (k: string) =>
    setInvalid((s) => {
      if (!s.has(k)) return s;
      const n = new Set(s);
      n.delete(k);
      return n;
    });

  const pickType = (v: string) => {
    setType(v);
    setParentEpic("");
    setParent("");
    // 规范规定 Sub-task 不使用优先级；切回其他类型时补默认值
    if (v === "Sub-task") setPriority(null);
    else if (!priority) setPriority(meta.priorities.includes("P2") ? "P2" : (meta.priorities[0] ?? null));
    clearMark("type");
  };

  // Sub-task 的父级两级联动：先选 Epic，再列该 Epic 下的 Story/Task
  const subPool = useMemo(
    () => (parentEpic ? meta.standardParents.filter((i) => i.parent === parentEpic) : []),
    [meta, parentEpic],
  );

  const bigRoster = meta.roster.length > 8;
  const pickAssigneeText = (text: string) => {
    setAssigneeText(text);
    const hit = meta.roster.find((m) => m.name === text || m.email === text);
    setAssignee(hit ? hit.email : null);
    clearMark("assignee");
  };

  const doRefresh = async () => {
    setBusy(true);
    setStatus({ text: "正在从 Confluence / Jira 拉取最新配置…" });
    try {
      const r = await api<{ spec: string; issueTotal: number; epicTotal: number; userTotal: number }>("POST", "/api/refresh");
      await onReloadMeta();
      setStatus({ text: `已更新: ${r.spec} · ${r.issueTotal} 张票（${r.epicTotal} 个 Epic）· ${r.userTotal} 名用户`, cls: "ok" });
    } catch (e) {
      setStatus({ text: errMsg(e), cls: "error" });
    } finally {
      setBusy(false);
    }
  };

  const doDraft = async () => {
    if (!input.trim()) {
      setStatus({ text: "先填需求描述", cls: "error" });
      return;
    }
    // 一次性给全信息：开票前就强制必填（指派必选一个人；Sub-task 不填优先级）
    const miss: string[] = [];
    const bad = new Set<string>();
    if (type !== "Sub-task" && !priority) {
      bad.add("priority");
      miss.push("优先级");
    }
    if (type === "Sub-task" && !parentEpic) bad.add("parentEpic");
    if (type !== "Epic" && !parent) {
      bad.add("parent");
      miss.push(type === "Sub-task" ? "父级（先选 Epic 再选 Story/Task）" : "父级");
    }
    if (!isL1 && !assignee) {
      bad.add("assignee");
      miss.push("指派给");
    }
    if (!dueDate) {
      bad.add("dueDate");
      miss.push("截止日期");
    }
    setInvalid(bad);
    if (miss.length) {
      setStatus({ text: `请先填: ${miss.join("、")}`, cls: "error" });
      return;
    }

    setBusy(true);
    setStatus({ text: "AI 开票中…（十几秒）" });
    try {
      const data = await api<{ id: string; draft: DraftFile }>("POST", "/api/draft", {
        input: input.trim(),
        splitCount: splitMode === "" ? null : splitMode === "1" ? 1 : splitN,
        defaults: {
          issueType: type,
          priority,
          parentKey: parent || null,
          assignee: isL1 ? user.jiraEmail : assignee,
          dueDate: dueDate || null,
        },
      });
      onDrafted({ id: data.id, owner: user.email, draft: data.draft });
      setStatus({ text: `拆出 ${data.draft.tickets.length} 张，可在卡片里微调后提交`, cls: "ok" });
    } catch (e) {
      setStatus({ text: errMsg(e), cls: "error" });
    } finally {
      setBusy(false);
    }
  };

  const shown = status ?? flash;
  return (
    <section className="card">
      <div className="frow">
        <div className="fgroup">
          <label>优先级</label>
          <Seg
            items={meta.priorities.map((p) => ({ label: p, value: p, color: PRIORITY_COLORS[p] }))}
            value={priority}
            onChange={(v) => {
              setPriority(v);
              clearMark("priority");
            }}
            disabled={type === "Sub-task"}
            invalid={invalid.has("priority")}
            title={type === "Sub-task" ? "规范规定 Sub-task 不使用优先级" : undefined}
          />
        </div>
        <div className="fgroup">
          <label>类型</label>
          <Seg items={types.map((t) => ({ label: t.name, value: t.name, color: TYPE_COLORS[t.name] }))} value={type} onChange={pickType} />
        </div>
        <div className="fgroup grow">
          <label>父级</label>
          <div className="parentPick">
            {type === "Sub-task" && (
              <select
                className={invalid.has("parentEpic") ? "invalid" : ""}
                value={parentEpic}
                onChange={(e) => {
                  setParentEpic(e.target.value);
                  setParent("");
                  clearMark("parentEpic");
                }}
              >
                <option value="">Epic（先选）</option>
                {meta.epics.map((i) => (
                  <option key={i.key} value={i.key}>{`${i.key} · ${i.summary.slice(0, 40)}`}</option>
                ))}
              </select>
            )}
            <select
              className={invalid.has("parent") ? "invalid" : ""}
              disabled={type === "Epic"}
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                clearMark("parent");
              }}
            >
              {type === "Epic" ? (
                <option value="">（Epic 无父级）</option>
              ) : type === "Sub-task" ? (
                <>
                  <option value="">
                    {parentEpic ? (subPool.length ? "选 Story/Task（必填）" : "该 Epic 下暂无 Story/Task") : "← 先选 Epic"}
                  </option>
                  {subPool.map((i) => (
                    <option key={i.key} value={i.key}>{`${i.key} · ${i.summary.slice(0, 48)}`}</option>
                  ))}
                </>
              ) : (
                <>
                  <option value="">父级（必填）</option>
                  {meta.epics.map((i) => (
                    <option key={i.key} value={i.key}>{`${i.key} · ${i.summary.slice(0, 48)}`}</option>
                  ))}
                </>
              )}
            </select>
          </div>
        </div>
      </div>
      <div className="frow">
        <div className="fgroup">
          <label>指派给</label>
          {isL1 ? (
            // 低级账号只能给自己开票：单按钮常亮，不可改
            <span className="seg lone">
              <button type="button" className="active">
                {user.name}（本人）
              </button>
            </span>
          ) : bigRoster ? (
            <input
              className={"assigneePick" + (invalid.has("assignee") ? " invalid" : "")}
              list="rosterList"
              placeholder="输入姓名搜索（必填）"
              value={assigneeText}
              onChange={(e) => pickAssigneeText(e.target.value)}
            />
          ) : (
            <Seg
              items={meta.roster.map((m) => ({ label: m.name, value: m.email }))}
              value={assignee}
              onChange={(v) => {
                setAssignee(v);
                clearMark("assignee");
              }}
              invalid={invalid.has("assignee")}
            />
          )}
          {bigRoster && (
            <datalist id="rosterList">
              {meta.roster.map((m) => (
                <option key={m.email} value={m.name}>
                  {m.email}
                </option>
              ))}
            </datalist>
          )}
        </div>
        <div className="fgroup">
          <label>截止日期</label>
          <input
            type="date"
            className={"dueDate" + (invalid.has("dueDate") ? " invalid" : "")}
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value);
              clearMark("dueDate");
            }}
          />
        </div>
      </div>
      <label>需求描述（口语化描述要做的事即可）</label>
      <textarea
        rows={4}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="例：给数据看板加导出 PDF 报告功能，需要后端生成接口和前端下载入口"
      />
      <div className="composeFoot">
        <div className="left">
          <span style={{ fontSize: 13, color: "var(--muted)" }}>拆票方式</span>
          <Seg
            items={[
              { label: "AI 自行决定", value: "" },
              { label: "不拆（单票）", value: "1" },
              { label: "指定数量", value: "n" },
            ]}
            value={splitMode}
            onChange={(v) => setSplitMode(v as "" | "1" | "n")}
          />
          {splitMode === "n" && (
            <input type="number" className="splitN" min={2} max={20} value={splitN} onChange={(e) => setSplitN(Number(e.target.value))} />
          )}
        </div>
        <div className="right">
          <span className={"status" + (shown?.cls ? " " + shown.cls : "")}>{shown?.text ?? ""}</span>
          <button className="ghost" disabled={busy} onClick={doRefresh}>
            更新config
          </button>
          <button className="primary" disabled={busy} onClick={doDraft}>
            AI 开票
          </button>
        </div>
      </div>
    </section>
  );
}
