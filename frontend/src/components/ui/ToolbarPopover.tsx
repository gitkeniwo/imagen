import { type ReactNode, useState } from "react";
import { useI18n } from "../../i18n";
import { Button, IconButton } from "./Button";
import Popover from "./Popover";

// The two shared toolbar popovers: "Filter" (what is listed) and "View" (how
// it is laid out). Every panel uses these instead of inline segment rows.
export function FilterPopover({
  activeCount,
  onReset,
  children,
}: {
  activeCount: number;
  onReset?: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      fixed
      className="toolbar-popover-wrap"
      panelClassName="toolbar-popover"
      panelProps={{ role: "dialog", "aria-label": t("filter") }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <Button
          className={`toolbar-trigger${activeCount > 0 ? " on" : ""}`}
          icon="filter"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {t("filter")}
          {activeCount > 0 && <span className="toolbar-trigger-count">{activeCount}</span>}
        </Button>
      }
    >
      {children}
      {onReset && activeCount > 0 && (
        <Button variant="link" className="toolbar-popover-reset" onClick={onReset}>
          {t("clear_filters")}
        </Button>
      )}
    </Popover>
  );
}

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
