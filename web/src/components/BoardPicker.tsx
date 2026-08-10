/**
 * 可见 board 的多选下拉。合起来只占一个控件的宽度（管理表格一行要塞很多列），
 * 展开后逐个勾选 —— 增删都在同一个地方，不必另设按钮。
 *
 * 受控组件：每次勾选立刻回调，调用方决定是攒着提交（建号表单）还是即时 PATCH（表格行）。
 */

import { useEffect, useRef, useState } from "react";

export function BoardPicker({
  boards,
  value,
  onChange,
  disabled,
  fixedLabel,
}: {
  /** 候选:全公司 board（已接入的排最前），勾选表示对该账号可见 */
  boards: Array<{ key: string; name: string }>;
  /** 当前勾选的 board key */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 给不受 boards 字段约束的账号用（管理员恒定全部）：只显示文字，不可展开。 */
  fixedLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // 面板用 fixed 定位挂在按钮下方：管理表格窄屏时套着 overflow 滚动容器，
  // absolute 面板会被裁掉，fixed 不受裁剪影响。
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open) {
      const r = box.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    setOpen((v) => !v);
  };

  // 点到别处就收起（mousedown 而不是 click：click 会先被面板内的 label 吃掉）。
  // 页面滚动/缩放也收起 —— fixed 面板不跟随锚点，与其漂移不如关掉；
  // 但面板自己内部的滚动（26 个 board 要翻）绝不能触发收起。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return; // 面板内滚动:放行
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (fixedLabel) return <span className="sub">{fixedLabel}</span>;

  const label = value.length === 0 ? "未授权（开不了票）" : value.length <= 2 ? value.join("、") : `${value.length} 个 board`;

  return (
    <div className="bpick" ref={box}>
      <button
        type="button"
        className={"bpickBtn" + (value.length === 0 ? " none" : "")}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="bpickLabel">{label}</span>
      </button>
      {open && pos && (
        <div className="bpickPanel" style={{ top: pos.top, left: pos.left, width: Math.max(pos.width, 240) }}>
          {boards.length === 0 && <div className="sub">board 清单还没拉取——点「更新config」</div>}
          {boards.map((b) => (
            <label key={b.key} className="bpickOpt" title={b.name}>
              <input
                type="checkbox"
                checked={value.includes(b.key)}
                onChange={(e) => onChange(e.target.checked ? [...value, b.key] : value.filter((x) => x !== b.key))}
              />
              <span className="bpickKey">{b.key}</span>
              <span className="bpickName">{b.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
