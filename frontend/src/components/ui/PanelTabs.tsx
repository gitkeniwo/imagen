import Icon, { type IconName } from "./Icon";

export interface PanelTab<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  count?: number;
}

// Labeled tab bar for the sidebar and the fullscreen manager. Labels and
// counts collapse to icons when the bar is narrow (container query in CSS);
// the label always stays available as tooltip + accessible name.
export default function PanelTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: PanelTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={["side-tabs", "panel-tabs", className].filter(Boolean).join(" ")} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          aria-label={tab.label}
          title={tab.label}
          className={`tab${value === tab.id ? " active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          <Icon name={tab.icon} size="sm" />
          <span className="tab-label">{tab.label}</span>
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
