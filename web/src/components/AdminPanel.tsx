/**
 * 管理面板（仅 admin tab 可见，接口另有 requireAdmin 硬门）：
 * 建号 / 定级 / 停用启用 / 重置密码 / 配 Jira 邮箱。
 * 停用即时生效（会话 30 秒内失效）；末位活跃管理员不可自锁（服务端拒绝）。
 */

import { useEffect, useState, type FormEvent } from "react";
import { api, errMsg } from "../api";
import { LEVEL_LABELS } from "../constants";
import type { AdminUser, UserLevel } from "../types";

const LEVELS: UserLevel[] = ["l1", "l2", "admin"];

export function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [status, setStatus] = useState<{ text: string; cls?: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  // 建号表单
  const [nEmail, setNEmail] = useState("");
  const [nName, setNName] = useState("");
  const [nPassword, setNPassword] = useState("");
  const [nLevel, setNLevel] = useState<UserLevel>("l1");
  const [nJira, setNJira] = useState("");

  const load = () => {
    api<{ users: AdminUser[] }>("GET", "/api/admin/users")
      .then((d) => setUsers(d.users))
      .catch((e) => setStatus({ text: errMsg(e), cls: "error" }));
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      load();
    } catch (e) {
      setStatus({ text: errMsg(e), cls: "error" });
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", "/api/admin/users", {
        email: nEmail.trim(),
        name: nName.trim(),
        password: nPassword,
        level: nLevel,
        ...(nJira.trim() ? { jiraEmail: nJira.trim() } : {}),
      });
      setStatus({ text: `已创建 ${nEmail.trim()}，请线下告知初始密码`, cls: "ok" });
      setNEmail("");
      setNName("");
      setNPassword("");
      setNLevel("l1");
      setNJira("");
    });
  };

  const patch = (email: string, body: Record<string, unknown>, okText?: string) =>
    run(async () => {
      await api("PATCH", `/api/admin/users/${encodeURIComponent(email)}`, body);
      if (okText) setStatus({ text: okText, cls: "ok" });
    });

  const resetPassword = (u: AdminUser) => {
    const pw = prompt(`给 ${u.name}（${u.email}）设置新密码（至少 8 位）：`);
    if (pw === null) return;
    void patch(u.email, { password: pw }, `已重置 ${u.email} 的密码，请线下告知`);
  };

  const editJira = (u: AdminUser) => {
    const v = prompt(`${u.name} 的 Jira 账号邮箱（留空 = 与登录邮箱相同）：`, u.jiraEmail ?? "");
    if (v === null) return;
    void patch(u.email, { jiraEmail: v.trim() });
  };

  return (
    <div>
      <section className="card">
        <form className="addUser" onSubmit={create}>
          <div className="fgroup">
            <label>工作邮箱（登录名）</label>
            <input type="email" required value={nEmail} onChange={(e) => setNEmail(e.target.value)} placeholder="name@bituslabs.com" />
          </div>
          <div className="fgroup">
            <label>姓名</label>
            <input required value={nName} onChange={(e) => setNName(e.target.value)} />
          </div>
          <div className="fgroup">
            <label>初始密码（至少 8 位）</label>
            <input required value={nPassword} onChange={(e) => setNPassword(e.target.value)} />
          </div>
          <div className="fgroup">
            <label>级别</label>
            <select value={nLevel} onChange={(e) => setNLevel(e.target.value as UserLevel)}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="fgroup">
            <label>Jira 邮箱（与登录邮箱不同时才填）</label>
            <input value={nJira} onChange={(e) => setNJira(e.target.value)} placeholder="留空 = 相同" />
          </div>
          <button className="primary" type="submit" disabled={busy}>
            添加用户
          </button>
        </form>
        <div className={"status" + (status?.cls ? " " + status.cls : "")} style={{ marginTop: 10, minHeight: 18 }}>
          {status?.text ?? ""}
        </div>
      </section>

      <section className="card">
        {!users && <div className="empty">加载中…</div>}
        {users && (
          <table className="utable">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>姓名</th>
                <th>级别</th>
                <th>状态</th>
                <th>Jira 邮箱</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>
                    <select value={u.level} disabled={busy} onChange={(e) => void patch(u.email, { level: e.target.value })}>
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_LABELS[l]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={u.active ? "" : "off"}>{u.active ? "正常" : "已停用"}</td>
                  <td>{u.jiraEmail ?? "同登录邮箱"}</td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>
                    <span className="rowBtns">
                      <button className="ghost" disabled={busy} onClick={() => resetPassword(u)}>
                        重置密码
                      </button>
                      <button className="ghost" disabled={busy} onClick={() => editJira(u)}>
                        Jira 邮箱
                      </button>
                      {u.active ? (
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`停用 ${u.email}？其会话将在 30 秒内失效。`)) void patch(u.email, { active: false });
                          }}
                        >
                          停用
                        </button>
                      ) : (
                        <button className="ghost" disabled={busy} onClick={() => void patch(u.email, { active: true })}>
                          启用
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
