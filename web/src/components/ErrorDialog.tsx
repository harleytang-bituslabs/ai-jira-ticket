/**
 * 承载那些「不能被悄悄弄丢」的错误。挂在 App 里、MainPage 之外 —— 切 tab 或
 * 被换成登录页都销毁不掉它,而那正是过去错误消息消失的原因。
 *
 * 复用现有的 .overlay/.modal/.mfoot,不引入新的视觉语汇。技术详情默认折叠:
 * 上游状态码和排查码是排查用的,不该糊在用户脸上,但截个图就能定位到日志。
 */

import { useEffect, useRef } from "react";
import type { Problem } from "../errors";

export interface DialogProblem extends Problem {
  title: string;
}

export function ErrorDialog({ problem, onClose }: { problem: DialogProblem; onClose: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasDetail = Boolean(problem.detail || problem.requestId);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal err" role="dialog" aria-modal="true" aria-label={problem.title} onClick={(e) => e.stopPropagation()}>
        <h2>{problem.title}</h2>
        <div className="errText">{problem.text}</div>
        {hasDetail && (
          <details className="errDetail">
            <summary>技术详情</summary>
            {problem.detail && <pre>{problem.detail}</pre>}
            {problem.requestId && <div className="errRef">排查码 {problem.requestId}</div>}
          </details>
        )}
        <div className="mfoot">
          <button ref={btn} className="primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
