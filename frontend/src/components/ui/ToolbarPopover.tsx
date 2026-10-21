import { type ReactNode, useState } from "react";
import { useI18n } from "../../i18n";
import { IconButton } from "./Button";
import Popover from "./Popover";

// The shared "View" toolbar popover (how a panel is laid out). Filters stay
// inline in each panel.
export function ViewPopover({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      fixed
      className="toolbar-popover-wrap"
      panelClassName="toolbar-popover"
      panelProps={{ role: "dialog", "aria-label": t("view") }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <IconButton
          className="toolbar-trigger"
          variant="outline"
          size="md"
          icon="columns"
          label={t("view")}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      }
    >
      {children}
    </Popover>
  );
}

export function PopoverSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="toolbar-popover-section">
      <span className="toolbar-popover-label">{label}</span>
      {children}
    </div>
  );
}
