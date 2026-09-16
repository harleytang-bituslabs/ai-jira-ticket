/**
 * 管理面板（仅 admin tab 可见，接口另有 requireAdmin 硬门）：
 * 建号 / 定级 / 授权 board / 定团队 / 停用启用 / 重置密码。
 * 登录名就是工作邮箱，也就是此人在 Jira 上的身份，没有第二个邮箱要配。
 * 停用即时生效（会话 30 秒内失效）；末位活跃管理员不可自锁（服务端拒绝）。
 *
 * 新账号默认不可见任何 board（= 开不了票），必须在这里显式勾选。
 * admin 恒定可见全部 board，其 boards 列表不起作用，故显示为「全部」。
 */

import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { presentError } from "../errors";
import { LEVEL_LABELS, TEAMS } from "../constants";
import { BoardPicker } from "./BoardPicker";
import type { AdminUser, UserLevel } from "../types";

const LEVELS: UserLevel[] = ["l1", "l2", "admin"];

/** 列表顺序：管理员在前，同级按姓名 —— 权限高的行最常被查看和改动。 */
const LEVEL_RANK: Record<UserLevel, number> = { admin: 0, l2: 1, l1: 2 };
const byLevelThenName = (a: AdminUser, b: AdminUser): number =>
  LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.name.localeCompare(b.name);

export function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  // 授权候选:全公司 board(已接入的排最前),来自「更新config」拉的清单
  const [boards, setBoards] = useState<Array<{ key: string; name: string }>>([]);
  const [status, setStatus] = useState<{ text: string; cls?: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  // 建号表单
  const [nEmail, setNEmail] = useState("");
  const [nName, setNName] = useState("");
  const [nPassword, setNPassword] = useState("");
  const [nLevel, setNLevel] = useState<UserLevel>("l1");
  const [nBoards, setNBoards] = useState<string[]>([]);
  const [nTeam, setNTeam] = useState("");

  const load = () => {
    api<{ users: AdminUser[] }>("GET", "/api/admin/users")
      .then((d) => setUsers([...d.users].sort(byLevelThenName)))
      .catch((e) => setStatus(presentError(e)));
  };
  useEffect(load, []);
  useEffect(() => {
    api<{ boards: Array<{ key: string; name: string }> }>("GET", "/api/admin/boards")
      .then((d) => setBoards(d.boards))
      .catch(() => {}); // 清单拉不到只是下拉变空,不打断管理页
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      load();
    } catch (e) {
      // 写操作失败必须被确认 —— 表格很长时内联那行可能在屏幕外
      setStatus(presentError(e, { as: "dialog" }));
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
        boards: nBoards,
        ...(nTeam ? { team: nTeam } : {}),
      });
      const warn = nLevel !== "admin" && nBoards.length === 0 ? "，但还没授权任何 board，他暂时开不了票" : "";
      setStatus({ text: `已创建 ${nEmail.trim()}，请线下告知初始密码${warn}`, cls: "ok" });
      setNEmail("");
      setNName("");
      setNPassword("");
      setNLevel("l1");
      setNBoards([]);
      setNTeam("");
    });
  };

  /** 按 Jira 参与记录猜此人该开哪些 board。识别失败不打断流程 —— 手动勾选始终可用。 */
  const detectBoards = async (email: string): Promise<string[] | null> => {
    if (!email.includes("@")) return null;
    try {
      const d = await api<{ boards: string[] }>("GET", `/api/admin/participation?email=${encodeURIComponent(email)}`);
      return d.boards;
    } catch {
      return null;
    }
  };

  const autofillBoards = async (email: string) => {
    const found = await detectBoards(email.trim());
    if (!found) return;
    setNBoards(found);
    setStatus(
      found.length
        ? { text: `按 Jira 参与记录识别到：${found.join("、")}（可手动改）`, cls: "ok" }
        : { text: "这个邮箱在已接入的 board 里没有参与记录，请手动勾选可见 board" },
    );
  };

  const syncBoardsFromJira = (u: AdminUser) =>
    void run(async () => {
      const found = await detectBoards(u.email);
      if (!found?.length) {
        setStatus({ text: `${u.email} 在已接入的 board 里没有参与记录，未改动` });
        return;
      }
      const merged = [...new Set([...u.boards, ...found])];
      await api("PATCH", `/api/admin/users/${encodeURIComponent(u.email)}`, { boards: merged });
      setStatus({ text: `已按参与记录给 ${u.email} 补上：${found.join("、")}`, cls: "ok" });
    });

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

  return (
    <div>
      <section className="card">
        <form className="addUser" onSubmit={create}>
          <div className="fgroup fEmail">
            <label>登录名（工作邮箱）</label>
            <input
              type="text"
              required
              value={nEmail}
              onChange={(e) => setNEmail(e.target.value)}
              onBlur={(e) => void autofillBoards(e.target.value)}
              placeholder="name@bituslabs.com"
            />
          </div>
          <div className="fgroup fName">
            <label>姓名</label>
            <input required value={nName} onChange={(e) => setNName(e.target.value)} />
          </div>
          <div className="fgroup fPass">
            <label>初始密码（至少 8 位）</label>
            <input required value={nPassword} onChange={(e) => setNPassword(e.target.value)} />
          </div>
          <div className="fgroup fLevel">
            <label>级别</label>
            <select value={nLevel} onChange={(e) => setNLevel(e.target.value as UserLevel)}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="fgroup fTeam">
            <label>团队</label>
            <select value={nTeam} onChange={(e) => setNTeam(e.target.value)}>
              <option value="">不填</option>
              {TEAMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="fgroup fBoards">
            <label>可见 board</label>
            <BoardPicker
              boards={boards}
              value={nBoards}
              onChange={setNBoards}
              {...(nLevel === "admin" ? { fixedLabel: "全部（管理员）" } : {})}
            />
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
          <div className="tableWrap">
          <table className="utable">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>姓名</th>
                <th>级别</th>
                <th>团队</th>
                <th>可见 board</th>
                <th>状态</th>
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
                  <td>
                    <select value={u.team ?? ""} disabled={busy} onChange={(e) => void patch(u.email, { team: e.target.value })}>
                      <option value="">—</option>
                      {TEAMS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <BoardPicker
                      boards={boards}
                      value={u.boards}
                      disabled={busy}
                      onChange={(next) => void patch(u.email, { boards: next })}
                      {...(u.level === "admin" ? { fixedLabel: "全部" } : {})}
                    />
                  </td>
                  <td className={u.active ? "" : "off"}>{u.active ? "正常" : "已停用"}</td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>
                    <span className="rowBtns">
                      <button className="ghost" disabled={busy} onClick={() => resetPassword(u)}>
                        重置密码
                      </button>
                      {u.level !== "admin" && (
                        <button className="ghost" disabled={busy} onClick={() => syncBoardsFromJira(u)} title="按 Jira 参与记录补上可见 board">
                          识别 board
                        </button>
                      )}
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
          </div>
        )}
      </section>
    </div>
  );
}
