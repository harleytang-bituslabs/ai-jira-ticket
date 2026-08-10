/**
 * 登录后的主界面：开票 / 历史 / 管理（admin）三个 tab。
 * 编辑器状态（current）与需求描述（input）提在这里，历史的「继续编辑」才能跨 tab 载入。
 */

import { useCallback, useEffect, useState } from "react";
import { api, clearSessionToken, errMsg } from "../api";
import { AdminPanel } from "../components/AdminPanel";
import { ChangePasswordDialog } from "../components/ChangePasswordDialog";
import { ComposeForm } from "../components/ComposeForm";
import { Editor } from "../components/Editor";
import { HistoryView } from "../components/HistoryView";
import { configFreshness } from "../constants";
import type { DraftEntry, Meta, User } from "../types";

export type Flash = { text: string; cls?: "ok" | "error" } | null;
type Tab = "create" | "history" | "admin";

export function MainPage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaErr, setMetaErr] = useState("");
  const [tab, setTab] = useState<Tab>("create");
  const [current, setCurrent] = useState<DraftEntry | null>(null);
  const [input, setInput] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [pwOpen, setPwOpen] = useState(false);

  const reloadMeta = useCallback(async () => {
    setMeta(await api<Meta>("GET", "/api/meta"));
  }, []);

  useEffect(() => {
    reloadMeta().catch((e) => setMetaErr(errMsg(e)));
  }, [reloadMeta]);

  // 登出 = 丢掉本标签页的 token。服务端无状态,没有要通知的东西;别的标签页不受影响。
  const logout = () => {
    clearSessionToken();
    onLogout();
  };

  /** 历史「继续编辑」→ 载入编辑器并切回开票 tab。 */
  const editFromHistory = (entry: DraftEntry) => {
    setCurrent(entry);
    setInput(entry.draft.meta.input);
    setFlash({ text: "已载入历史草稿，可继续编辑后提交", cls: "ok" });
    setTab("create");
  };

  return (
    <>
      <header>
        <h1>ajt · AI 开票</h1>
        {meta ? (
          // 悬停给出三份数据各自的确切时间（分叉时才需要细看）
          <span className="sub" title={configFreshness(meta).detail}>
            项目 {meta.projectKey} · {configFreshness(meta).text}
          </span>
        ) : (
          <span className="sub">{metaErr || "加载中…"}</span>
        )}
        <nav>
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>
            开票
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            历史
          </button>
          {user.level === "admin" && (
            <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>
              管理
            </button>
          )}
        </nav>
        <span className="userbox">
          <span className="who">{user.name}</span>
          <button onClick={() => setPwOpen(true)}>改密</button>
          <button onClick={logout}>退出</button>
        </span>
      </header>
      <main>
        {tab === "create" && meta && (
          <>
            <ComposeForm
              meta={meta}
              user={user}
              input={input}
              setInput={setInput}
              flash={flash}
              onReloadMeta={reloadMeta}
              onDrafted={(entry) => {
                setCurrent(entry);
                setFlash(null);
              }}
            />
            <Editor
              meta={meta}
              user={user}
              current={current}
              setCurrent={setCurrent}
              onRecordDeleted={() => {
                setCurrent(null);
                setFlash({ text: "草稿记录已删除", cls: "ok" });
              }}
            />
          </>
        )}
        {tab === "create" && !meta && <div className="empty">{metaErr || "加载中…"}</div>}
        {tab === "history" && (
          <HistoryView
            user={user}
            roster={meta?.roster ?? []}
            currentId={current?.id ?? null}
            onEdit={editFromHistory}
            onDeletedCurrent={() => setCurrent(null)}
          />
        )}
        {tab === "admin" && user.level === "admin" && <AdminPanel />}
      </main>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </>
  );
}
