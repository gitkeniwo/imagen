import { type CSSProperties, type MouseEvent, useState } from "react";
import { api, type Tag } from "../api";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";
import Icon from "./ui/Icon";
import Sheet from "./ui/Sheet";

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
// On the phone the chips stay on one scrolling line and the full list lives in
// a bottom sheet — only the tags collapse, never the source/star filters.
export default function TagFilterRow({
  tags,
  value,
  onChange,
  phone = false,
  total,
  onTagsChanged,
}: {
  tags: Tag[];
  value: number | null;
  onChange: (id: number | null) => void;
  phone?: boolean;
  // Library total, for the sheet footer when no tag is selected.
  total?: number;
  // Called after a tag is deleted so the page can reload tags and results.
  onTagsChanged?: () => void;
}) {
  const { t } = useI18n();
  const askConfirm = useConfirm();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [search, setSearch] = useState("");

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage may be unavailable; the toggle still works for this session.
    }
  };

  // Blank space anywhere in the row toggles the list too; chips and the
  // chevron keep their own clicks. The chevron stays the keyboard control.
  const toggleFromRow = (e: MouseEvent<HTMLDivElement>) => {
    if (tags.length === 0) return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("button, a, input, select, textarea")) return;
    toggle();
  };

  const removeTag = async (tag: Tag) => {
    const ok = await askConfirm({
      message: t("confirm_delete_tag", { name: tag.name, n: tag.count }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTag(tag.id);
      if (value === tag.id) onChange(null);
      onTagsChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const chip = (tag: Tag, onClick?: () => void) => (
    <span key={tag.id} className="tag-chip-wrap">
      <button
        className={`tag-chip${value === tag.id ? " on" : ""}`}
        style={tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined}
        aria-pressed={value === tag.id}
        onClick={onClick ?? (() => onChange(value === tag.id ? null : tag.id))}
      >
        {tag.name}
        <span className="tag-count">{tag.count}</span>
      </button>
      <button
        type="button"
        className="tag-chip-del"
        title={t("delete_tag")}
        aria-label={`${t("delete_tag")}: ${tag.name}`}
        onClick={() => void removeTag(tag)}
      >
        <Icon name="close" size="sm" />
      </button>
    </span>
  );

  const active = tags.find((tag) => tag.id === value);
  const allChip = (
    <button
      className={`tag-chip${value === null ? " on" : ""}`}
      aria-pressed={value === null}
      onClick={() => onChange(null)}
    >
      {t("tags_all")}
    </button>
  );

  if (phone) {
    if (tags.length === 0) return null;
    const filtered = search.trim()
      ? tags.filter((tag) => tag.name.toLowerCase().includes(search.trim().toLowerCase()))
      : tags;
    const resultCount = active?.count ?? total;
    return (
      <>
        <div className="phone-tagrow">
          <div className="phone-tagscroll">
            {allChip}
            {tags.map((tag) => chip(tag))}
          </div>
          <button
            type="button"
            className="phone-tagmore"
            aria-haspopup="dialog"
            onClick={() => {
              setSearch("");
              setSheetOpen(true);
            }}
          >
            {t("tags_label")}
            {value !== null && <span className="phone-tagmore-count">1</span>}
            <Icon name="chevronDown" size="sm" />
          </button>
        </div>

        {sheetOpen && (
          <Sheet
            title={t("phone_tags_title")}
            onClose={() => setSheetOpen(false)}
            footer={
              <>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => onChange(null)}
                >
                  {t("phone_clear")}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  style={{ flex: 2 }}
                  onClick={() => setSheetOpen(false)}
                >
                  {resultCount !== undefined
                    ? t("phone_show_n", { n: resultCount })
                    : t("done")}
                </button>
              </>
            }
          >
            <label className="sheet-tags-search">
              <Icon name="search" size="sm" />
              <input
                value={search}
                placeholder={t("phone_find_tag")}
                aria-label={t("phone_find_tag")}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="sheet-tag-wrap">
              {filtered.length === 0 && <span className="muted small">{t("no_tags")}</span>}
              {filtered.map((tag) =>
                chip(tag, () => {
                  onChange(value === tag.id ? null : tag.id);
                }),
              )}
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <div
      className={`tag-filter-row${collapsed ? " collapsed" : ""}${
        tags.length > 0 ? " toggleable" : ""
      }`}
      onClick={toggleFromRow}
    >
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
            {tags.map((tag) => chip(tag))}
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
