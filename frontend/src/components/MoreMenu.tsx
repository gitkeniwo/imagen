import { useI18n } from "../i18n";
import type { PanelCounts } from "../usePanelCounts";
import Icon from "./ui/Icon";
import { RemoteChip } from "./RemoteIndicator";
import { useRemote } from "../remote";
import appIcon from "../assets/app-icon.png";

export type MorePage = "favorites" | "drafts" | "bin";

// "More" tab: the pages that don't get their own tab, plus usage and settings.
// Rows reuse the existing pages / modals; this is only the list.
export default function MoreMenu({
  counts,
  onOpenPage,
  onOpenUsage,
  onOpenSettings,
}: {
  counts: PanelCounts;
  onOpenPage: (page: MorePage) => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const { remote } = useRemote();

  const row = (
    icon: "favorite" | "drafts" | "bin" | "usage" | "settings",
    label: string,
    value: number | undefined,
    onClick: () => void,
    sub?: string,
    iconClass?: string,
  ) => (
    <button type="button" className="phone-li" onClick={onClick}>
      <span className={`phone-li-icon${iconClass ? ` ${iconClass}` : ""}`}>
        <Icon name={icon} />
      </span>
      <span className="phone-li-text">
        {label}
        {sub && <span>{sub}</span>}
      </span>
      {value !== undefined && <span className="phone-li-value">{value}</span>}
      <Icon name="next" size="sm" className="phone-li-chev" />
    </button>
  );

  return (
    <div className="phone-page">
      <header className="phone-head">
        <img className="phone-logo" src={appIcon} alt="" />
        <h1>{t("tab_more")}</h1>
        {remote && <RemoteChip />}
      </header>

      <main className="phone-body phone-body-wide">
        <div className="phone-list">
          {row("favorite", t("tab_favorites"), counts.favorites, () => onOpenPage("favorites"), undefined, "warn")}
          {row("drafts", t("tab_drafts"), counts.drafts, () => onOpenPage("drafts"))}
          {row("bin", t("tab_bin"), counts.bin, () => onOpenPage("bin"))}
        </div>

        <div className="phone-list">
          {row("usage", t("usage_title"), undefined, onOpenUsage)}
          {row("settings", t("settings"), undefined, onOpenSettings)}
        </div>

        <div className="phone-callout">
          <Icon name="info" size="sm" />
          <span>{t("phone_add_to_home")}</span>
        </div>
      </main>
    </div>
  );
}
