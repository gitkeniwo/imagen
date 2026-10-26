import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, Generation, ImageRow, imgFileUrl, imgThumbUrl } from "../api";
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
import { useIsPhone } from "../useIsPhone";
import { useBackLayer } from "../backStack";

// Full-screen lightbox: one rounded window with a dark stage (image + prev/next)
// and a 360px inspector (metadata, actions, prompt, inputs, note, tags).
// For generated images it also surfaces the prompt behind the image (copy /
// reuse), a ★ favorite toggle, and an editable note — so a good image is one
// click from saving its prompt.
// `list` (optional) enables prev/next navigation within the surrounding grid.
export interface ViewerPager {
  // Absolute position of the first item in `list` within the full result set.
  offset: number;
  total: number;
  // Must use the same filters/sort as the grid that opened the viewer.
  fetch(offset: number, limit: number): Promise<ImageRow[]>;
}

export default function ImageViewer({
  image,
  list,
  pager,
  onIndexChange,
  onClose,
  onAddToTray,
  onTagsChanged,
  onReuse,
  onChanged,
}: {
  image: ImageRow;
  list: ImageRow[];
  pager?: ViewerPager;
  onIndexChange?: (globalIndex: number, image?: ImageRow) => void;
  onClose: () => void;
  onAddToTray: (img: ImageRow) => void;
  onTagsChanged: () => void;
  onReuse?: (g: Generation) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<ImageRow[]>(() => {
    const seen = new Set<number>();
    const seed = (list.length ? list : [image]).filter((img) => {
      if (seen.has(img.id)) return false;
      seen.add(img.id);
      return true;
    });
    if (!seen.has(image.id)) seed.unshift(image);
    return seed;
  });
  const [idx, setIdx] = useState(() =>
    Math.max(0, items.findIndex((i) => i.id === image.id)),
  );
  const [startOffset, setStartOffset] = useState(pager?.offset ?? 0);
  const total = Math.max(items.length, pager?.total ?? items.length);
  const itemsRef = useRef(items);
  const idxRef = useRef(idx);
  const startRef = useRef(startOffset);
  const totalRef = useRef(total);
  const setCurrentIndex = useCallback((next: number) => {
    idxRef.current = next;
    setIdx(next);
  }, []);
  const close = useCallback(() => {
    const globalIndex = Math.min(
      Math.max(0, totalRef.current - 1),
      startRef.current + idxRef.current,
    );
    const lastImage =
      itemsRef.current[Math.min(idxRef.current, itemsRef.current.length - 1)] ?? image;
    onIndexChange?.(globalIndex, lastImage);
    onClose();
  }, [image, onClose, onIndexChange]);
  useBackLayer(true, close);
  const current = items[Math.min(idx, items.length - 1)] ?? image;
  const globalIndex = Math.min(
    Math.max(0, total - 1),
    startOffset + idx,
  );
  const globalPosition = globalIndex + 1;
  const multi = total > 1;
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
  // Phone: bottom sheet-style info panel; collapsed shows a 3-line prompt.
  const phone = useIsPhone();
  const [expanded, setExpanded] = useState(false);
  // Phone: user-dragged sheet height in px (null = content-sized, capped by CSS).
  const [sheetH, setSheetH] = useState<number | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ y: number; h: number; max: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const side = sideRef.current;
    const win = side?.parentElement;
    if (!side || !win) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, h: side.offsetHeight, max: win.clientHeight - 140 };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setSheetH(Math.round(Math.min(d.max, Math.max(120, d.h + d.y - e.clientY))));
  };
  const onHandleUp = () => {
    dragRef.current = null;
  };

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    startRef.current = startOffset;
  }, [startOffset]);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);

  const batchSizeRef = useRef(Math.max(1, list.length || items.length));
  const nextLoad = useRef<Promise<boolean> | null>(null);
  const prevLoad = useRef<Promise<boolean> | null>(null);
  const loadNext = useCallback(() => {
    if (!pager) return Promise.resolve(false);
    if (nextLoad.current) return nextLoad.current;
    const from = startRef.current + itemsRef.current.length;
    if (from >= totalRef.current) return Promise.resolve(false);
    const request = pager
      .fetch(from, batchSizeRef.current)
      .then((rows) => {
        const seen = new Set(itemsRef.current.map((img) => img.id));
        const fresh = rows.filter((img) => {
          if (seen.has(img.id)) return false;
          seen.add(img.id);
          return true;
        });
        if (fresh.length === 0) return false;
        const merged = [...itemsRef.current, ...fresh];
        itemsRef.current = merged;
        setItems(merged);
        return true;
      })
      .finally(() => {
        if (nextLoad.current === request) nextLoad.current = null;
      });
    nextLoad.current = request;
    return request;
  }, [pager]);
  const loadPrev = useCallback(() => {
    if (!pager) return Promise.resolve(false);
    if (prevLoad.current) return prevLoad.current;
    const from = startRef.current;
    if (from <= 0) return Promise.resolve(false);
    const to = Math.max(0, from - batchSizeRef.current);
    const request = pager
      .fetch(to, from - to)
      .then((rows) => {
        const seen = new Set(itemsRef.current.map((img) => img.id));
        const fresh = rows.filter((img) => {
          if (seen.has(img.id)) return false;
          seen.add(img.id);
          return true;
        });
        if (fresh.length === 0) return false;
        const merged = [...fresh, ...itemsRef.current];
        const shiftedIndex = idxRef.current + fresh.length;
        itemsRef.current = merged;
        startRef.current = to;
        idxRef.current = shiftedIndex;
        setItems(merged);
        setStartOffset(to);
        setIdx(shiftedIndex);
        return true;
      })
      .finally(() => {
        if (prevLoad.current === request) prevLoad.current = null;
      });
    prevLoad.current = request;
    return request;
  }, [pager]);

  // Warm the browser cache around the current image. On phones this is the
  // difference between a blank frame and an immediate full-resolution swap.
  const prevImageId = items[idx - 1]?.id;
  const nextImageId = items[idx + 1]?.id;
  useEffect(() => {
    for (const id of [prevImageId, nextImageId]) {
      if (id == null) continue;
      const preload = new Image();
      preload.src = imgFileUrl(id);
      void preload.decode().catch(() => {});
    }
  }, [prevImageId, nextImageId]);

  // Fetch the next/previous grid page while the user is still 2-3 images away
  // from its boundary, so crossing it only changes the displayed image.
  useEffect(() => {
    if (!pager) return;
    if (idx >= items.length - 3) void loadNext().catch(() => {});
    if (idx <= 2) void loadPrev().catch(() => {});
  }, [idx, items.length, loadNext, loadPrev, pager]);

  // Reset editable tags when navigating to another image.
  useEffect(() => {
    setTagIds((current.tags ?? []).map((x) => x.id));
    setStarred(!!current.starred);
    setNote(current.note ?? "");
    setSource(current.source);
    setCopied(false);
    setExpanded(false);
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

  const navBusy = useRef(false);
  const [navLoading, setNavLoading] = useState<"prev" | "next" | null>(null);
  const goTo = useCallback(
    async (delta: -1 | 1) => {
      if (navBusy.current) return;
      const local = idxRef.current;
      if (delta > 0 && local < itemsRef.current.length - 1) {
        setCurrentIndex(local + 1);
        return;
      }
      if (delta < 0 && local > 0) {
        setCurrentIndex(local - 1);
        return;
      }
      const direction = delta > 0 ? "next" : "prev";
      if (
        (delta > 0 && startRef.current + itemsRef.current.length >= totalRef.current) ||
        (delta < 0 && startRef.current <= 0)
      ) {
        return;
      }
      navBusy.current = true;
      setNavLoading(direction);
      try {
        const loaded = await (delta > 0 ? loadNext() : loadPrev());
        if (!loaded) return;
        if (delta > 0 && idxRef.current < itemsRef.current.length - 1) {
          setCurrentIndex(idxRef.current + 1);
        } else if (delta < 0 && idxRef.current > 0) {
          setCurrentIndex(idxRef.current - 1);
        }
      } catch (e) {
        toast(t("op_failed", { msg: (e as Error).message }));
      } finally {
        navBusy.current = false;
        setNavLoading(null);
      }
    },
    [loadNext, loadPrev, setCurrentIndex, t, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "i" || e.key === "I") setPanelHidden((h) => !h);
      else if (zoomedRef.current) return;
      else if (e.key === "ArrowLeft") void goTo(-1);
      else if (e.key === "ArrowRight") void goTo(1);
    };
    if (editingGen || duplicatingGen) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, goTo, editingGen, duplicatingGen]);

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

  const moreMenu = (
    <Menu
      items={[
        // Full screen hides the action bar; its actions live here.
        ...(panelHidden
          ? [
              ...(onReuse && gen ? [{ icon: "reuse" as const, label: t("reuse"), onSelect: () => onReuse(gen) }] : []),
              { icon: "addToRefs" as const, label: t("phone_use_as_ref"), onSelect: () => onAddToTray(current) },
              { icon: "favorite" as const, label: starred ? t("unfavorite") : t("favorite"), onSelect: toggleStar },
              { icon: "download" as const, label: t("download"), onSelect: () => downloadImage(current) },
            ]
          : []),
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
  );

  const prev = () => void goTo(-1);
  const next = () => void goTo(1);
  const atStart = globalIndex <= 0;
  const atEnd = globalIndex >= total - 1;
  const format = (current.mime || "").replace("image/", "").toUpperCase();
  const params = gen
    ? [gen.model.replace("-image", "").replace("-preview", ""), gen.aspect_ratio, gen.resolution, format]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="viewer-overlay" role="dialog" aria-modal="true" onClick={close}>
      <div
        className={`viewer-window${panelHidden ? " panel-hidden" : ""}${phone ? " phone" : ""}${phone && expanded ? " expanded" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <ZoomStage
          image={current}
          panelHidden={panelHidden}
          onTogglePanel={() => setPanelHidden((h) => !h)}
          onZoomedChange={onZoomedChange}
        >
          {(phone || panelHidden) && (
            <div className="viewer-phone-top">
              <IconButton variant="overlay" size="md" icon="close" label={t("close")} onClick={close} />
              {multi && <span className="viewer-phone-count">{globalPosition} / {total}</span>}
              <span className="viewer-phone-menu">{moreMenu}</span>
            </div>
          )}
          {multi && (
            <>
              <span className="viewer-count">{globalPosition} / {total}</span>
              {/* Phone: the outer fifths of the stage switch images while not zoomed. */}
              {phone && !zoomed && (
                <>
                  <button
                    type="button"
                    className="viewer-zone prev"
                    aria-label={t("prev_image")}
                    disabled={atStart || navLoading === "prev"}
                    onClick={prev}
                  />
                  <button
                    type="button"
                    className="viewer-zone next"
                    aria-label={t("next_image")}
                    disabled={atEnd || navLoading === "next"}
                    onClick={next}
                  />
                </>
              )}
              <IconButton
                className="viewer-nav prev"
                variant="overlay"
                size="lg"
                icon="prev"
                label={t("prev_image")}
                disabled={atStart || navLoading === "prev"}
                hidden={zoomed || phone}
                onClick={prev}
              />
              <IconButton
                className="viewer-nav next"
                variant="overlay"
                size="lg"
                icon="next"
                label={t("next_image")}
                disabled={atEnd || navLoading === "next"}
                hidden={zoomed || phone}
                onClick={next}
              />
            </>
          )}
        </ZoomStage>

        <aside
          ref={sideRef}
          className="viewer-side"
          aria-label={t("image_info")}
          hidden={panelHidden}
          style={phone && sheetH != null ? { height: sheetH, maxHeight: "none", flex: "0 0 auto" } : undefined}
        >
          {phone && (
            <div
              className="viewer-sheet-handle"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onDoubleClick={() => setSheetH(null)}
            />
          )}
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
              {moreMenu}
              <IconButton
                className="viewer-close"
                size="md"
                icon="close"
                label={t("close")}
                onClick={close}
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
            <div className="viewer-phone-actions">
              {onReuse && gen && (
                <button type="button" onClick={() => onReuse(gen)}>
                  <Icon name="reuse" />
                  {t("reuse")}
                </button>
              )}
              <button type="button" className="prim" onClick={() => onAddToTray(current)}>
                <Icon name="addToRefs" />
                {t("phone_use_as_ref")}
              </button>
              <button type="button" className={starred ? "is-starred" : undefined} aria-pressed={starred} onClick={toggleStar}>
                <Icon name="favorite" filled={starred} />
                {starred ? t("unfavorite") : t("favorite")}
              </button>
              <button type="button" onClick={() => downloadImage(current)}>
                <Icon name="download" />
                {t("download")}
              </button>
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
                <button type="button" className="viewer-prompt-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? t("phone_show_less_prompt") : t("phone_show_full_prompt")}
                  <Icon name="chevronDown" size="sm" />
                </button>
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

            {(current.tags ?? []).length > 0 && (
              <div className="viewer-phone-tags">
                {(current.tags ?? []).map((tg) => <span key={tg.id}>{tg.name}</span>)}
              </div>
            )}

            {source === "generated" && (
              <section className="viewer-section viewer-section-edit">
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

            <section className="viewer-section viewer-section-edit">
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
