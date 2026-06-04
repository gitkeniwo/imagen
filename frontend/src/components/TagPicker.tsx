import { type CSSProperties, useEffect, useState } from "react";
import { api, Tag } from "../api";
import { useI18n } from "../i18n";

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
        {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
        {tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className={`tag-chip${selected.includes(tag.id) ? " on" : ""}`}
            style={
              tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined
            }
            onClick={() => toggle(tag.id)}
          >
            {tag.name}
            <span className="tag-count">{tag.count}</span>
          </button>
        ))}
      </div>
      {allowCreate && (
        <div className="tag-create">
          <input
            value={draft}
            placeholder={t("new_tag_placeholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
          />
          <button type="button" onClick={create} disabled={busy || !draft.trim()}>
            {t("create")}
          </button>
        </div>
      )}
    </div>
  );
}
