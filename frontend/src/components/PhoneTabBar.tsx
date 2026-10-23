import { useI18n } from "../i18n";
import Icon, { type IconName } from "./ui/Icon";

export type PhoneTab = "library" | "create" | "history" | "more";

const TABS: { id: PhoneTab; icon: IconName }[] = [
  { id: "library", icon: "library" },
  { id: "create", icon: "generated" },
  { id: "history", icon: "history" },
  { id: "more", icon: "more" },
];

export function tabLabel(t: (key: string) => string, tab: PhoneTab) {
  return t(
    tab === "create" ? "tab_generate" : tab === "more" ? "tab_more" : `tab_${tab}`,
  );
}

// Floating capsule tab bar. The selected item is a raised white pill in the
// same style as the desktop PanelTabs track.
export default function PhoneTabBar({
  value,
  onChange,
  badge = 0,
}: {
  value: PhoneTab;
  onChange: (tab: PhoneTab) => void;
  badge?: number;
}) {
  const { t } = useI18n();
  return (
    <nav className="phone-tabs" aria-label={t("phone_sections")}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`phone-tab${value === tab.id ? " on" : ""}`}
          aria-current={value === tab.id ? "page" : undefined}
          onClick={() => onChange(tab.id)}
        >
          <Icon name={tab.icon} />
          <span>{tabLabel(t, tab.id)}</span>
          {tab.id === "create" && badge > 0 && (
            <span className="phone-badge" aria-label={t("phone_running_n", { n: badge })}>
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
