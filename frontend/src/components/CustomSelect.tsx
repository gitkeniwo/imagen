import { useState } from "react";
import Icon from "./ui/Icon";
import Popover from "./ui/Popover";

// A browser-independent select (shadcn-style popover with check mark).
export default function CustomSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.id === value);

  return (
    <Popover
      className="custom-select"
      panelClassName="custom-select-popover"
      panelProps={{ role: "listbox" }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button
          type="button"
          className={`custom-select-trigger${open ? " open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>{selected?.label ?? value}</span>
          <Icon name="chevronDown" size="sm" className="chevron" />
        </button>
      }
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={o.id === value}
          className="custom-select-item"
          onClick={() => {
            onChange(o.id);
            setOpen(false);
          }}
        >
          <span className="check">{o.id === value && <Icon name="check" size="sm" />}</span>
          {o.label}
        </button>
      ))}
    </Popover>
  );
}
