import { type ReactNode, useState } from "react";
import { useI18n } from "../../i18n";
import { Button, IconButton } from "./Button";
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
          icon="columnSettings"
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

// Toolbar trigger for the less common filters. Shows how many are active and
// is highlighted while any is, so a hidden filter never looks like missing data.
export function FilterPopover({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = active ? t("hist_filter_more_n", { n: active }) : t("hist_filter_more");
  return (
    <Popover
      fixed
      className="toolbar-popover-wrap"
      panelClassName="toolbar-popover"
      panelProps={{ role: "dialog", "aria-label": t("hist_filter_more") }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <Button
          className={`skip-toggle filter-trigger${active ? " on" : ""}`}
          icon="filter"
          title={label}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="filter-label">{t("hist_filter_more")}</span>
          {active > 0 && <span className="filter-count">{active}</span>}
        </Button>
      }
    >
      {children}
      {active > 0 && (
        <Button size="sm" variant="ghost" icon="clear" onClick={onClear}>
          {t("clear_filters")}
        </Button>
      )}
    </Popover>
  );
}
