/**
 * 最后一道兜底：渲染期崩溃与漏网的 Promise rejection。
 *
 * 为什么值得：ComposeForm 的七个表单选项（类型/优先级/父票/指派/起止日期）
 * 没有提升到 MainPage，一次渲染崩溃会把它们连同白屏一起吃掉，而用户看不到
 * 任何提示——他只知道「页面没了」。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { classify, raiseDialog } from "../errors";

/** 全局挂一次：未捕获的 rejection 与非 React 的运行时错误。 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("unhandledrejection", (e) => {
    raiseDialog(classify(e.reason));
  });
  window.addEventListener("error", (e) => {
    if (e.error) raiseDialog(classify(e.error));
  });
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("界面崩溃:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    // 白屏比什么都糟:至少告诉他发生了什么、怎么回到可用状态
    return (
      <div className="loginWrap">
        <div className="loginCard">
          <h1>界面出错了</h1>
          <div className="sub">刷新页面可以继续使用。如果反复出现，把这一步的操作告诉维护者。</div>
          <button className="primary" onClick={() => location.reload()}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
