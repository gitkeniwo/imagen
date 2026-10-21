import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";
import Popover from "./Popover";

export interface MenuItem {
  label: string;
  icon?: IconName;
  // Right-aligned secondary text (a count, a shortcut).
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

// Dropdown action menu. `renderTrigger` receives the open state and a toggle
// so the caller decides how the trigger looks (text button, "⋯" icon …).
export default function Menu({
  items,
  renderTrigger,
  align = "end",
  className,
  footer,
}: {
  items: MenuItem[];
  renderTrigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  align?: "start" | "end";
  className?: string;
  // Extra non-item content under the items (e.g. colour swatches).
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the menu so arrow keys / Enter work right away.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <Popover
      fixed
      align={align}
      className={className}
      panelClassName={`menu menu-${align}`}
      panelProps={{ role: "menu", onKeyDown }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={renderTrigger({ open, toggle: () => setOpen((v) => !v) })}
    >
      <div ref={panelRef}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              setOpen(false);
              item.onSelect();
            }}
          >
            {item.icon && <Icon name={item.icon} size="sm" />}
            <span className="menu-item-label">{item.label}</span>
            {item.hint !== undefined && <span className="menu-item-hint">{item.hint}</span>}
          </button>
        ))}
        {footer && <div className="menu-footer">{footer(() => setOpen(false))}</div>}
      </div>
    </Popover>
  );
}
