import { type CSSProperties, useEffect, useState } from "react";
import { api, Tag } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";

// Reusable tag selector: toggle chips + create-new. `selected` is a list of tag
// ids; `onChange` receives the new list. Used by the composer (archive targets)
// and the image viewer (the image's own tags).
export default function TagPicker({
  selected,
  onChange,
  version = 0,
  allowCreate = true,
}: {
  selected: number[];
  onChange: (ids: number[]) => void;
  version?: number;
  allowCreate?: boolean;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.listTags().then((r) => setTags(r.tags));
  useEffect(() => {
    load();
  }, [version]);

  const toggle = (id: number) =>
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    try {
      const tag = await api.createTag(name);
      setDraft("");
      await load();
      if (!selected.includes(tag.id)) onChange([...selected, tag.id]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tag-picker">
      <div className="tag-chip-row">
        {tags.length === 0 && !allowCreate && <span className="muted small">{t("no_tags")}</span>}
        {tags.map((tag) => {
          const on = selected.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              className={`tag-chip${on ? " on" : ""}`}
              aria-pressed={on}
              style={
                tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined
              }
              onClick={() => toggle(tag.id)}
            >
              {on && <Icon name="check" size="sm" />}
              {tag.name}
              <span className="tag-count">{tag.count}</span>
            </button>
          );
        })}
        {allowCreate && (
          // Inline "+ new tag" chip: type a name and press Enter.
          <label className={`tag-chip tag-chip-new${busy ? " busy" : ""}`}>
            <Icon name="add" size="sm" />
            <input
              value={draft}
              placeholder={t("new_tag_placeholder")}
              aria-label={t("new_tag_placeholder")}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                }
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}
