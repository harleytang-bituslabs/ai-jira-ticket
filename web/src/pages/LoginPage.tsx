import { useState, type FormEvent } from "react";
import { api, errMsg } from "../api";
import type { User } from "../types";

export function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setErr("请输入邮箱和密码");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const d = await api<{ user: User }>("POST", "/api/login", { email: email.trim(), password });
      onLogin(d.user);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginWrap">
      <form className="loginCard" onSubmit={submit}>
        <h1>ajt · AI 开票</h1>
        <div className="sub">用工作邮箱登录；没有账号请找管理员开通</div>
        <label>工作邮箱</label>
        <input
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@bituslabs.com"
        />
        <label>密码</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
        <div className={"status" + (err ? " error" : "")}>{err}</div>
      </form>
    </div>
  );
}
