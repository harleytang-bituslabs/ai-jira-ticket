/**
 * 会话门：先问 /api/me，有会话进主页，没有出登录页。
 *
 * 错误弹窗挂在这一层（MainPage 之外），所以它不会随页面切换或登出被卸载 ——
 * 过去正是这一点让「AI 开票」失败的红字随组件一起消失，用户只看见自己被登出。
 */

import { useEffect, useState } from "react";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { ErrorDialog, type DialogProblem } from "./components/ErrorDialog";
import { ERROR_EVENT } from "./errors";
import { LoginPage } from "./pages/LoginPage";
import { MainPage } from "./pages/MainPage";
import type { User } from "./types";

const SESSION_LOST = "会话已过期，请重新登录";

export function App() {
  // undefined = 会话状态未知（加载中），null = 未登录
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [problem, setProblem] = useState<DialogProblem | null>(null);
  const [loginNote, setLoginNote] = useState("");

  useEffect(() => {
    api<{ user: User }>("GET", "/api/me")
      .then((d) => setMe(d.user))
      .catch(() => setMe(null));

    // 会话真的没了才走这条路 —— api.ts 只在 category === "session" 时广播
    const onAnon = () => {
      setLoginNote(SESSION_LOST);
      setMe(null);
    };
    const onError = (e: Event) => setProblem((e as CustomEvent<DialogProblem>).detail);
    window.addEventListener(UNAUTHORIZED_EVENT, onAnon);
    window.addEventListener(ERROR_EVENT, onError);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onAnon);
      window.removeEventListener(ERROR_EVENT, onError);
    };
  }, []);

  const dialog = problem && <ErrorDialog problem={problem} onClose={() => setProblem(null)} />;

  if (me === undefined) return <div className="empty">加载中…</div>;
  if (!me)
    return (
      <>
        <LoginPage
          note={loginNote}
          onLogin={(u) => {
            setLoginNote("");
            setMe(u);
          }}
        />
        {dialog}
      </>
    );
  return (
    <>
      <MainPage user={me} onLogout={() => setMe(null)} />
      {dialog}
    </>
  );
}
