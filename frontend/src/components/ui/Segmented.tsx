import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  // Shown as tooltip; required when `label` is omitted in favor of an icon.
  title?: string;
  iconOnly?: boolean;
}

// Single-select button group (resolution, format, columns, concurrency …).
// Renders the shared `.seg` styles; extra classes keep per-screen sizing.
export default function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
  title,
  disabled,
  dense,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  // Compact numeric chooser (column counts, concurrency).
  dense?: boolean;
}) {
  return (
    <div
      className={["seg", dense && "density-seg", className].filter(Boolean).join(" ")}
      role="group"
      title={title}
    >
      {options.map((o) => {
        const on = o.value === value;
        const tip = o.title ?? (typeof o.label === "string" ? o.label : undefined);
        return (
          <button
            key={String(o.value)}
            type="button"
            className={on ? "on" : ""}
            aria-pressed={on}
            aria-label={o.iconOnly ? tip : undefined}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size="sm" />}
            {!o.iconOnly && o.label}
          </button>
        );
      })}
    </div>
  );
}
