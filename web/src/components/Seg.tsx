/** 单选按钮组（值级配色：选中态上 --c 颜色白字）。 */

import type { CSSProperties } from "react";

export interface SegItem {
  label: string;
  value: string;
  color?: string;
}

export function Seg({
  items,
  value,
  onChange,
  disabled = false,
  invalid = false,
  title,
}: {
  items: SegItem[];
  value: string | null;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  title?: string;
}) {
  return (
    <span className={"seg" + (disabled ? " disabled" : "") + (invalid ? " invalid" : "")} title={title}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className={it.value === value ? "active" : ""}
          data-c={it.color ? "1" : undefined}
          style={it.color ? ({ "--c": it.color } as CSSProperties) : undefined}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </span>
  );
}
