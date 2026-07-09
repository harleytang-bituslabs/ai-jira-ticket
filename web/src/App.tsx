/** 会话门：先问 /api/me，有会话进主页，没有出登录页；任何 API 401 都弹回登录。 */

import { useEffect, useState } from "react";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { MainPage } from "./pages/MainPage";
import type { User } from "./types";

export function App() {
  // undefined = 会话状态未知（加载中），null = 未登录
  const [me, setMe] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User }>("GET", "/api/me")
      .then((d) => setMe(d.user))
      .catch(() => setMe(null));
    const onAnon = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onAnon);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onAnon);
  }, []);

  if (me === undefined) return <div className="empty">加载中…</div>;
  if (!me) return <LoginPage onLogin={setMe} />;
  return <MainPage user={me} onLogout={() => setMe(null)} />;
}
