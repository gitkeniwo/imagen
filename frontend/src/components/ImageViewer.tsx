import { useCallback, useEffect, useRef, useState } from "react";
import { api, Generation, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { copyText } from "../clipboard";
import TagPicker from "./TagPicker";
import { useToast } from "./Toast";
import AddHistoryModal from "./AddHistoryModal";
import Icon from "./ui/Icon";
import { Button, IconButton } from "./ui/Button";
import Menu from "./ui/Menu";
import { downloadImage } from "./GenerationCard";
import { peekProps } from "./HoverPeek";
import ZoomStage from "./ZoomStage";

// Full-screen lightbox: one rounded window with a dark stage (image + prev/next)
// and a 360px inspector (metadata, actions, prompt, inputs, note, tags).
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
  // While zoomed, ←/→ pan nothing and switch nothing; the arrows hide.
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  const onZoomedChange = useCallback((z: boolean) => {
    zoomedRef.current = z;
    setZoomed(z);
  }, []);
  const [panelHidden, setPanelHidden] = useState(false);

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
    const ok = await copyText(gen.prompt);
    if (!ok) {
      toast(t("copy_failed"));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "i" || e.key === "I") setPanelHidden((h) => !h);
      else if (zoomedRef.current) return;
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(items.length - 1, i + 1));
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
  const prev = () => setIdx((i) => Math.max(0, i - 1));
  const next = () => setIdx((i) => Math.min(items.length - 1, i + 1));
  const format = (current.mime || "").replace("image/", "").toUpperCase();
  const params = gen
    ? [gen.model.replace("-image", "").replace("-preview", ""), gen.aspect_ratio, gen.resolution, format]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="viewer-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className={`viewer-window${panelHidden ? " panel-hidden" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <ZoomStage
          image={current}
          panelHidden={panelHidden}
          onTogglePanel={() => setPanelHidden((h) => !h)}
          onZoomedChange={onZoomedChange}
        >
          {multi && (
            <>
              <span className="viewer-count">{idx + 1} / {items.length}</span>
              <IconButton
                className="viewer-nav prev"
                variant="overlay"
                size="lg"
                icon="prev"
                label={t("prev_image")}
                disabled={idx === 0}
                hidden={zoomed}
                onClick={prev}
              />
              <IconButton
                className="viewer-nav next"
                variant="overlay"
                size="lg"
                icon="next"
                label={t("next_image")}
                disabled={idx === items.length - 1}
                hidden={zoomed}
                onClick={next}
              />
            </>
          )}
        </ZoomStage>

        <aside className="viewer-side" aria-label={t("image_info")} hidden={panelHidden}>
          <div className="viewer-top">
            <div className="viewer-head">
              <h2 className="viewer-name">{current.filename}</h2>
              <IconButton
                className={`viewer-star${starred ? " is-starred" : ""}`}
                size="md"
                icon="favorite"
                filled={starred}
                label={starred ? t("unfavorite") : t("favorite")}
                aria-pressed={starred}
                onClick={toggleStar}
              />
              <IconButton
                size="md"
                icon="download"
                label={t("download")}
                onClick={() => downloadImage(current)}
              />
              <Menu
                items={[
                  ...(gen
                    ? [
                        { icon: "edit" as const, label: t("edit_annotation"), onSelect: () => setEditingGen(gen) },
                        { icon: "duplicate" as const, label: t("duplicate_record"), onSelect: () => setDuplicatingGen(gen) },
                      ]
                    : []),
                  {
                    icon: source === "upload" ? ("generated" as const) : ("uploaded" as const),
                    label: source === "upload" ? t("mark_as_generated") : t("mark_as_upload"),
                    onSelect: toggleSource,
                  },
                ]}
                renderTrigger={({ open, toggle }) => (
                  <IconButton
                    size="md"
                    icon="more"
                    label={t("more_actions")}
                    aria-expanded={open}
                    onClick={toggle}
                  />
                )}
              />
              <IconButton
                className="viewer-close"
                size="md"
                icon="close"
                label={t("close")}
                onClick={onClose}
              />
            </div>
            <div className="viewer-meta">
              <button
                type="button"
                className={`badge source-badge ${source}`}
                title={source === "upload" ? t("mark_as_generated") : t("mark_as_upload")}
                onClick={toggleSource}
              >
                <Icon name={source === "upload" ? "uploaded" : "generated"} size="sm" />
                {source === "upload" ? t("tag_upload") : t("tag_generated")}
              </button>
              <span>{current.width}×{current.height}</span>
              <span className="sep">·</span>
              <span>
                {format}
                {current.byte_size ? ` · ${fmtBytes(current.byte_size)}` : ""}
              </span>
              <span className="sep">·</span>
              <span>{fmtTime(current.created_at)}</span>
            </div>
            <div className="viewer-actions">
              <Button variant="primary" icon="addToRefs" onClick={() => onAddToTray(current)}>
                {t("add_to_input")}
              </Button>
              {onReuse && gen && (
                <Button icon="reuse" onClick={() => onReuse(gen)}>
                  {t("reuse")}
                </Button>
              )}
            </div>
          </div>

          <div className="viewer-sections">
            {source === "generated" && gen?.prompt && (
              <section className="viewer-section">
                <div className="viewer-section-head">
                  <h3>{t("prompt_label")}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={copied ? "check" : "copy"}
                    title={t("copy_prompt")}
                    onClick={copyPrompt}
                  >
                    {copied ? t("copied") : t("copy")}
                  </Button>
                </div>
                <p className="viewer-prompt-text">{gen.prompt}</p>
                <span className="viewer-params">{params}</span>
              </section>
            )}

            {source === "generated" && gen?.inputs && gen.inputs.length > 0 && (
              <section className="viewer-section">
                <h3>{t("viewer_inputs", { n: gen.inputs.length })}</h3>
                <div className="viewer-inputs">
                  {gen.inputs.map((im, i) =>
                    im.deleted_at ? (
                      <span key={im.id} className="deleted-tile" title={t("deleted_label")}>
                        <Icon name="imageMissing" />
                      </span>
                    ) : (
                      <button
                        key={im.id}
                        type="button"
                        className="viewer-input"
                        aria-label={`${im.filename} · ${t("add_to_input")}`}
                        {...peekProps(im, t("peek_input", { n: i + 1 }))}
                        onClick={() => onAddToTray(im)}
                      >
                        <img src={imgThumbUrl(im.id)} alt="" />
                        <span className="pos">{i + 1}</span>
                      </button>
                    ),
                  )}
                </div>
              </section>
            )}

            {source === "generated" && (
              <section className="viewer-section">
                <label htmlFor="viewer-note" className="viewer-section-label">{t("note_label")}</label>
                <textarea
                  id="viewer-note"
                  className="viewer-note"
                  rows={2}
                  value={note}
                  placeholder={t("note_placeholder")}
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={saveNote}
                />
              </section>
            )}

            <section className="viewer-section">
              <h3>{t("tags_label")}</h3>
              <TagPicker selected={tagIds} onChange={applyTags} />
            </section>
          </div>
        </aside>
      </div>

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// "10-19 14:32" in local time; earlier years keep the year.
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (x: number) => String(x).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}
