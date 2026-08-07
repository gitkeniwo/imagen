import { useEffect, useState } from "react";
import { api, Generation, ImageRow, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import TagPicker from "./TagPicker";
import { useToast } from "./Toast";
import AddHistoryModal from "./AddHistoryModal";

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
  const toast = useToast();
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
  const [source, setSource] = useState(current.source);
  const [copied, setCopied] = useState(false);
  const [editingGen, setEditingGen] = useState<Generation | null>(null);
  const [duplicatingGen, setDuplicatingGen] = useState<Generation | null>(null);

  // Reset editable tags when navigating to another image.
  useEffect(() => {
    setTagIds((current.tags ?? []).map((x) => x.id));
    setStarred(!!current.starred);
    setNote(current.note ?? "");
    setSource(current.source);
    setCopied(false);
  }, [current.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the prompt that produced this image (generated images only).
  useEffect(() => {
    let alive = true;
    setGen(null);
    if (source === "generated") {
      api
        .generationByOutput(current.id)
        .then((g) => alive && setGen(g))
        .catch(() => alive && setGen(null));
    }
    return () => {
      alive = false;
    };
  }, [current.id, source]);

  const toggleStar = async () => {
    const prev = starred;
    const next = !starred;
    setStarred(next);
    try {
      await api.patchImage(current.id, { starred: next });
      current.starred = next ? 1 : 0; // keep the in-memory row in sync for re-open
      onChanged?.();
    } catch (e) {
      setStarred(prev);
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleSource = async () => {
    const prev = source;
    const next = source === "generated" ? "upload" : "generated";
    setSource(next);
    try {
      await api.patchImage(current.id, { source: next });
      current.source = next; // keep the in-memory row in sync for re-open
      onChanged?.();
    } catch (e) {
      setSource(prev);
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const saveNote = async () => {
    const trimmed = note.trim();
    if (trimmed === (current.note ?? "")) return;
    try {
      await api.patchImage(current.id, { note: trimmed });
      current.note = trimmed; // keep the in-memory row in sync for re-open
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
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
    if (editingGen || duplicatingGen) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, onClose, editingGen, duplicatingGen]);

  const refreshGeneration = () => {
    if (source !== "generated") return;
    api
      .generationByOutput(current.id)
      .then(setGen)
      .catch(() => setGen(null));
  };

  const applyTags = async (next: number[]) => {
    const prev = tagIds;
    const added = next.filter((x) => !prev.includes(x));
    const removed = prev.filter((x) => !next.includes(x));
    setTagIds(next);
    try {
      if (added.length) await api.batchTag([current.id], added, "add");
      if (removed.length) await api.batchTag([current.id], removed, "remove");
      // Keep the in-memory row in sync so prev/next within this lightbox
      // session (and re-open) shows the edited tags.
      const { tags } = await api.listTags();
      current.tags = tags
        .filter((tg) => next.includes(tg.id))
        .map(({ id, name, color }) => ({ id, name, color }));
      onTagsChanged();
    } catch (e) {
      setTagIds(prev);
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const multi = items.length > 1;

  return (
    <div className="viewer-overlay" role="dialog" aria-modal="true" onClick={onClose}>
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
            <button
              className="link-btn"
              title={t("toggle_source_hint")}
              onClick={toggleSource}
            >
              {source === "upload" ? t("tag_upload") : t("tag_generated")}
            </button>
            {multi && ` · ${idx + 1}/${items.length}`}
          </div>

          {source === "generated" && gen?.prompt && (
            <div className="viewer-prompt">
              <div className="viewer-prompt-head">
                <label>{t("prompt_label")}</label>
                <button className="link-btn" onClick={copyPrompt}>
                  {copied ? t("copied") : t("copy_prompt")}
                </button>
              </div>
              <p className="viewer-prompt-text">{gen.prompt}</p>
              {gen.inputs && gen.inputs.length > 0 && (
                <div className="viewer-inputs gen-inputs">
                  {gen.inputs.map((im) =>
                    im.deleted_at ? (
                      <span
                        key={im.id}
                        className="deleted-tile"
                        title={t("deleted_label")}
                      >
                        <i className="fa-solid fa-trash-can" />
                      </span>
                    ) : (
                      <img
                        key={im.id}
                        src={imgThumbUrl(im.id)}
                        alt={im.filename}
                        title={`${im.filename} · ${t("add_to_input")}`}
                        onClick={() => onAddToTray(im)}
                        {...pressable(() => onAddToTray(im))}
                      />
                    ),
                  )}
                </div>
              )}
              {onReuse && (
                <button
                  className="viewer-reuse"
                  onClick={() => onReuse(gen)}
                >
                  {t("reuse")}
                </button>
              )}
              <div className="viewer-prompt-actions">
                <button
                  className="icon-btn"
                  title={t("edit_annotation")}
                  onClick={() => setEditingGen(gen)}
                >
                  <i className="fa-solid fa-pen" />
                </button>
                <button
                  className="icon-btn"
                  title={t("duplicate")}
                  onClick={() => setDuplicatingGen(gen)}
                >
                  <i className="fa-solid fa-clone" />
                </button>
              </div>
            </div>
          )}

          {source === "generated" && (
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

      {editingGen && (
        <AddHistoryModal
          existing={editingGen}
          aboveViewer
          onClose={() => setEditingGen(null)}
          onSaved={() => {
            setEditingGen(null);
            refreshGeneration();
            onChanged?.();
          }}
        />
      )}
      {duplicatingGen && (
        <AddHistoryModal
          duplicate={duplicatingGen}
          aboveViewer
          onClose={() => setDuplicatingGen(null)}
          onSaved={() => {
            setDuplicatingGen(null);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
