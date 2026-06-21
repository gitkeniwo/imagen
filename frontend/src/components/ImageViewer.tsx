import { useEffect, useState } from "react";
import { api, Generation, ImageRow, imgFileUrl } from "../api";
import { useI18n } from "../i18n";
import TagPicker from "./TagPicker";

// Full-screen lightbox: big image + metadata + inline tag editing + actions.
// For generated images it also surfaces the prompt behind the image (copy /
// reuse), a ★ favorite toggle, and an editable note — so a good image is one
// click from saving its prompt.
// `list` (optional) enables prev/next navigation within the surrounding grid.
export default function ImageViewer({
  image,
  list,
  onClose,
  onAddToTray,
  onTagsChanged,
  onReuse,
  onChanged,
}: {
  image: ImageRow;
  list: ImageRow[];
  onClose: () => void;
  onAddToTray: (img: ImageRow) => void;
  onTagsChanged: () => void;
  onReuse?: (g: Generation) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const items = list.length ? list : [image];
  const [idx, setIdx] = useState(
    Math.max(0, items.findIndex((i) => i.id === image.id)),
  );
  const current = items[Math.min(idx, items.length - 1)] ?? image;
  const [tagIds, setTagIds] = useState<number[]>(
    (current.tags ?? []).map((x) => x.id),
  );
  // Prompt/favorite/note state for the current image (generated images only).
  const [gen, setGen] = useState<Generation | null>(null);
  const [starred, setStarred] = useState(!!current.starred);
  const [note, setNote] = useState(current.note ?? "");
  const [copied, setCopied] = useState(false);

  // Reset editable tags when navigating to another image.
  useEffect(() => {
    setTagIds((current.tags ?? []).map((x) => x.id));
    setStarred(!!current.starred);
    setNote(current.note ?? "");
    setCopied(false);
  }, [current.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the prompt that produced this image (generated images only).
  useEffect(() => {
    let alive = true;
    setGen(null);
    if (current.source === "generated") {
      api
        .generationByOutput(current.id)
        .then((g) => alive && setGen(g))
        .catch(() => alive && setGen(null));
    }
    return () => {
      alive = false;
    };
  }, [current.id, current.source]);

  const toggleStar = async () => {
    const next = !starred;
    setStarred(next);
    await api.patchImage(current.id, { starred: next });
    onChanged?.();
  };

  const saveNote = async () => {
    const trimmed = note.trim();
    if (trimmed === (current.note ?? "")) return;
    await api.patchImage(current.id, { note: trimmed });
    current.note = trimmed; // keep the in-memory row in sync for re-open
    onChanged?.();
  };

  const copyPrompt = async () => {
    if (!gen?.prompt) return;
    try {
      await navigator.clipboard.writeText(gen.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight")
        setIdx((i) => Math.min(items.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, onClose]);

  const applyTags = async (next: number[]) => {
    const added = next.filter((x) => !tagIds.includes(x));
    const removed = tagIds.filter((x) => !next.includes(x));
    setTagIds(next);
    if (added.length) await api.batchTag([current.id], added, "add");
    if (removed.length) await api.batchTag([current.id], removed, "remove");
    onTagsChanged();
  };

  const multi = items.length > 1;

  return (
    <div className="viewer-overlay" onClick={onClose}>
      <button className="viewer-close" title={t("close")} onClick={onClose}>
        ×
      </button>
      {multi && (
        <button
          className="viewer-nav prev"
          disabled={idx === 0}
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => Math.max(0, i - 1));
          }}
        >
          ‹
        </button>
      )}

      <div className="viewer-body" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-stage">
          <img src={imgFileUrl(current.id)} alt={current.filename} />
        </div>
        <div className="viewer-side">
          <div className="viewer-name-row">
            <div className="viewer-name">{current.filename}</div>
            <button
              className={`star viewer-star${starred ? " is-starred" : ""}`}
              title={starred ? t("unfavorite") : t("favorite")}
              onClick={toggleStar}
            >
              {starred ? "★" : "☆"}
            </button>
          </div>
          <div className="muted small">
            {current.width}×{current.height} ·{" "}
            {current.source === "upload" ? t("tag_upload") : t("tag_generated")}
            {multi && ` · ${idx + 1}/${items.length}`}
          </div>

          {current.source === "generated" && gen?.prompt && (
            <div className="viewer-prompt">
              <div className="viewer-prompt-head">
                <label>{t("prompt_label")}</label>
                <button className="link-btn" onClick={copyPrompt}>
                  {copied ? t("copied") : t("copy_prompt")}
                </button>
              </div>
              <p className="viewer-prompt-text">{gen.prompt}</p>
              {onReuse && (
                <button
                  className="viewer-reuse"
                  onClick={() => onReuse(gen)}
                >
                  {t("reuse")}
                </button>
              )}
            </div>
          )}

          {current.source === "generated" && (
            <>
              <label style={{ marginTop: 16 }}>{t("note_label")}</label>
              <textarea
                className="viewer-note"
                rows={2}
                value={note}
                placeholder={t("note_placeholder")}
                onChange={(e) => setNote(e.target.value)}
                onBlur={saveNote}
              />
            </>
          )}

          <label style={{ marginTop: 16 }}>{t("tags_label")}</label>
          <TagPicker selected={tagIds} onChange={applyTags} />

          <div className="row" style={{ marginTop: 16 }}>
            <button onClick={() => onAddToTray(current)}>{t("add_to_input")}</button>
            <a href={imgFileUrl(current.id)} download>
              <button style={{ width: "100%" }}>{t("download")}</button>
            </a>
          </div>
        </div>
      </div>

      {multi && (
        <button
          className="viewer-nav next"
          disabled={idx === items.length - 1}
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => Math.min(items.length - 1, i + 1));
          }}
        >
          ›
        </button>
      )}
    </div>
  );
}
