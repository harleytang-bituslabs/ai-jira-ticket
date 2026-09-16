import { useState, type FormEvent } from "react";
import { api } from "../api";
import { presentError } from "../errors";

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; cls: string }>({ text: "", cls: "" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== again) {
      setStatus({ text: "两次输入的新密码不一致", cls: "error" });
      return;
    }
    setBusy(true);
    try {
      await api("POST", "/api/me/password", { oldPassword, newPassword });
      setStatus({ text: "密码已修改", cls: "ok" });
      setTimeout(onClose, 800);
    } catch (e) {
      setStatus({ text: presentError(e)?.text ?? "", cls: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>修改密码</h2>
        <label>当前密码</label>
        <input type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
        <label>新密码（至少 8 位）</label>
        <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <label>再输一遍</label>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        <div className={"status " + status.cls} style={{ marginTop: 10, minHeight: 18 }}>
          {status.text}
        </div>
        <div className="mfoot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            确认修改
          </button>
        </div>
      </form>
    </div>
  );
}
