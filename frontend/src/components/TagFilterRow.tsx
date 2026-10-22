import { type CSSProperties, useState } from "react";
import type { Tag } from "../api";
import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";

const COLLAPSED_KEY = "imagen-tags-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Tag filter chips shared by Library and History. Collapsing keeps one line:
// the active chip plus how many tags are hidden. The choice is per browser.
export default function TagFilterRow({
  tags,
  value,
  onChange,
}: {
  tags: Tag[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage may be unavailable; the toggle still works for this session.
    }
  };

  const chip = (tag: Tag) => (
    <button
      key={tag.id}
      className={`tag-chip${value === tag.id ? " on" : ""}`}
      style={tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined}
      onClick={() => onChange(tag.id)}
    >
      {tag.name}
      <span className="tag-count">{tag.count}</span>
    </button>
  );

  const active = tags.find((tag) => tag.id === value);
  const allChip = (
    <button className={`tag-chip${value === null ? " on" : ""}`} onClick={() => onChange(null)}>
      {t("tags_all")}
    </button>
  );

  return (
    <div className={`tag-filter-row${collapsed ? " collapsed" : ""}`}>
      <div className="tag-filter-chips">
        {collapsed ? (
          <>
            {active ? chip(active) : allChip}
            <span className="tag-hidden-count">
              {t("tags_hidden_n", { n: tags.length - (active ? 1 : 0) })}
            </span>
          </>
        ) : (
          <>
            {allChip}
            {tags.map(chip)}
          </>
        )}
      </div>
      {tags.length > 0 && (
        <IconButton
          className="tag-filter-toggle"
          icon={collapsed ? "chevronDown" : "chevronUp"}
          label={collapsed ? t("tags_show") : t("tags_hide")}
          aria-expanded={!collapsed}
          onClick={toggle}
        />
      )}
    </div>
  );
}
