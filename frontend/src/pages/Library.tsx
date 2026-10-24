import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";
import { api, downloadName, ImageRow, Tag, batchDownloadUrl, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import { imageDragProps } from "../imageDrag";
import { pageSizedToColumns } from "../pageSize";
import SearchBox from "../components/SearchBox";
import TagFilterRow from "../components/TagFilterRow";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { useRemote } from "../remote";
import { RemoteChip } from "../components/RemoteIndicator";
import Icon from "../components/ui/Icon";
import Sheet from "../components/ui/Sheet";
import { Button, IconButton } from "../components/ui/Button";
import appIcon from "../assets/app-icon.png";
import Segmented from "../components/ui/Segmented";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";

const COMPACT_PAGE_SIZE = 24;
const FULL_PAGE_SIZE = 60;
const GRID_COLUMNS_KEY = "imagen-library-columns";
const GRID_COLUMN_OPTIONS = [1, 2, 3, 4, 5];
const THUMB_SIZE_KEY = "imagen-library-thumb";
const THUMB_SIZES = ["s", "m", "l"] as const;
type ThumbSize = (typeof THUMB_SIZES)[number];
const THUMB_MIN: Record<ThumbSize, string> = { s: "120px", m: "170px", l: "240px" };

function initialGridColumns() {
  const saved = Number(localStorage.getItem(GRID_COLUMNS_KEY));
  return GRID_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

function initialThumbSize(): ThumbSize {
  const saved = localStorage.getItem(THUMB_SIZE_KEY) as ThumbSize | null;
  return saved && THUMB_SIZES.includes(saved) ? saved : "m";
}

export default function Library({
  addToTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  onChanged,
  phone = false,
  onSelectModeChange,
}: {
  addToTray: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
  // Phone layout: full-width island with its own title row and floating
  // selection capsule. Reuses the same data and card logic as desktop.
  phone?: boolean;
  // Lets the phone shell hide the tab bar while a selection is active.
  onSelectModeChange?: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const { remote } = useRemote();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [source, setSource] = useState<string>("");
  // Phone: the search field stays folded until asked for (or while a query is active).
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [columns, setColumns] = useState(initialGridColumns);
  const [thumbSize, setThumbSize] = useState<ThumbSize>(initialThumbSize);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchMode, setBatchMode] = useState<"add" | "remove" | null>(null);
  const [draft, setDraft] = useState("");
  // Phone only: tag batch actions live in a bottom sheet.
  const [batchSheet, setBatchSheet] = useState(false);
  // Long-press → multi-select on the phone. Timers live for the whole grid.
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  // Phone thumbnails offer 2/3/4 columns; a saved desktop width of 1 or 5 is
  // clamped here (the stored key stays the same on both layouts).
  const phoneColumns = Math.min(4, Math.max(2, columns));
  const effectiveColumns = phone ? phoneColumns : columns;
  // Compact grid columns are fixed, so the page must hold whole rows; the full
  // grid uses auto-fill and stays on a fixed page size.
  const pageSize = compact
    ? pageSizedToColumns(COMPACT_PAGE_SIZE, effectiveColumns)
    : FULL_PAGE_SIZE;

  const load = () => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.listImages({
        limit: pageSize,
        offset: page * pageSize,
        source: source || undefined,
        tag: tagFilter ?? undefined,
        starred: starredOnly || undefined,
        q: query || undefined,
      }),
      api.listTags(),
    ])
      .then(([r, tagsRes]) => {
        setImages(r.images);
        setTotal(r.total);
        setTags(tagsRes.tags);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [source, tagFilter, starredOnly, query, page, pageSize, refreshKey]);

  useEffect(() => {
    localStorage.setItem(GRID_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(THUMB_SIZE_KEY, thumbSize);
  }, [thumbSize]);

  useEffect(() => {
    if (!phone) return;
    onSelectModeChange?.(selectMode);
    return () => onSelectModeChange?.(false);
  }, [phone, selectMode, onSelectModeChange]);

  const hasActiveFilters =
    !!query || starredOnly || !!source || tagFilter !== null;

  const clearFilters = () => {
    setQuery("");
    setStarredOnly(false);
    setSource("");
    setTagFilter(null);
    setPage(0);
  };

  const toggleStar = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: !img.starred });
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const download = (img: ImageRow) => {
    const a = document.createElement("a");
    a.href = imgFileUrl(img.id);
    a.download = downloadName(img);
    a.click();
  };

  const remove = async (img: ImageRow) => {
    const ok = await askConfirm({
      message: t("confirm_delete"),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteImage(img.id);
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allSelected =
    images.length > 0 && images.every((img) => selected.has(img.id));

  const selectAllOnPage = () =>
    setSelected((s) => new Set([...s, ...images.map((img) => img.id)]));

  const onCardClick = (img: ImageRow) => {
    // A long press already switched to selection; swallow the click it emits.
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (selectMode) toggleSelect(img.id);
    else onOpenViewer(img, images);
  };

  const endLongPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  const startLongPress = (e: PointerEvent, img: ImageRow) => {
    if (!phone || selectMode || e.pointerType === "mouse") return;
    pressStart.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      setSelectMode(true);
      setSelected(new Set([img.id]));
    }, 450);
  };

  const moveLongPress = (e: PointerEvent) => {
    const start = pressStart.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 8 || Math.abs(e.clientY - start.y) > 8) {
      endLongPress();
    }
  };

  const stopSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setBatchMode(null);
    setBatchSheet(false);
  };

  const useSelectedAsRefs = () => {
    for (const img of images) if (selected.has(img.id)) addToTray(img);
  };

  const applyBatch = async (tagId: number) => {
    if (!batchMode || selected.size === 0) return;
    try {
      await api.batchTag([...selected], [tagId], batchMode);
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const downloadSelected = () => {
    const a = document.createElement("a");
    a.href = batchDownloadUrl([...selected]);
    a.download = "";
    a.click();
  };

  const createAndApply = async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      const tag = await api.createTag(name);
      setDraft("");
      if (selected.size > 0) await api.batchTag([...selected], [tag.id], "add");
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  const pager = hasPages ? (
    <div className="pager">
      <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
        {t("prev_page")}
      </button>
      <span className="muted small">
        {t("page_status", { page: page + 1, pages: pageCount, total })}
      </span>
      <button
        disabled={page >= pageCount - 1 || loading}
        onClick={() => setPage((p) => p + 1)}
      >
        {t("next_page")}
      </button>
    </div>
  ) : null;

  const phonePager = (
    <div className="phone-pager-row">
      <div className="phone-pg">
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("prev_page")}
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <Icon name="prev" size="sm" />
          </button>
        )}
        <span>
          {hasPages
            ? t("phone_page_status", { page: page + 1, pages: pageCount })
            : t("phone_total_images", { n: total })}
        </span>
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("next_page")}
            disabled={page >= pageCount - 1 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <Icon name="next" size="sm" />
          </button>
        )}
      </div>
      {hasPages && <span className="phone-pager-total">{t("phone_total_images", { n: total })}</span>}
      <div className="phone-size" role="group" aria-label={t("columns_per_row")}>
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            className={phoneColumns === n ? "on" : ""}
            aria-pressed={phoneColumns === n}
            aria-label={t("phone_columns_n", { n })}
            onClick={() => {
              setColumns(n);
              setPage(0);
            }}
          >
            <i
              style={{
                gridTemplateColumns: `repeat(${n}, 1fr)`,
                gridTemplateRows: `repeat(${n}, 1fr)`,
              }}
            >
              {Array.from({ length: n * n }, (_, i) => (
                <b key={i} />
              ))}
            </i>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`panel library-panel${compact ? " compact" : ""}${phone ? " phone-panel-inner" : ""}`}>
      {phone && (
        selectMode ? (
          <div className="phone-head phone-selhead">
            <button type="button" className="phone-textbtn" onClick={stopSelect}>
              {t("cancel")}
            </button>
            <b>{t("selected_n", { n: selected.size })}</b>
            <button
              type="button"
              className="phone-textbtn"
              disabled={images.length === 0 || allSelected}
              onClick={selectAllOnPage}
            >
              {t("select_all")}
            </button>
          </div>
        ) : (
          <div className="phone-head">
            <img className="phone-logo" src={appIcon} alt="" />
            <h1>
              {t("tab_library")} <span>{total}</span>
            </h1>
            {remote && <RemoteChip />}
            <IconButton
              icon="selectMode"
              label={t("select_mode")}
              onClick={() => {
                setSelectMode(true);
                setSelected(new Set());
                setBatchMode(null);
              }}
            />
          </div>
        )
      )}

      <div className="library-sticky">
        <div className="library-toolbar" hidden={phone && !searchOpen && !query}>
          <SearchBox
            autoFocus={phone && searchOpen && !query}
            value={query}
            onChange={(q) => {
              setQuery(q);
              setPage(0);
            }}
            placeholder={t("search_placeholder_library")}
          />
          {!phone && (
            <ViewPopover>
              {compact ? (
                <PopoverSection label={t("columns_per_row")}>
                  <Segmented
                    dense
                    value={columns}
                    onChange={(n) => {
                      setColumns(n);
                      setPage(0);
                    }}
                    options={GRID_COLUMN_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                  />
                </PopoverSection>
              ) : (
                <PopoverSection label={t("thumb_size_label")}>
                  <Segmented
                    dense
                    value={thumbSize}
                    onChange={setThumbSize}
                    options={THUMB_SIZES.map((s) => ({ value: s, label: s.toUpperCase() }))}
                  />
                </PopoverSection>
              )}
            </ViewPopover>
          )}
          {!phone && !selectMode && (
            <Button
              className="select-toggle"
              icon="selectMode"
              title={t("select_mode")}
              aria-label={t("select_mode")}
              onClick={() => {
                setSelectMode(true);
                setSelected(new Set());
                setBatchMode(null);
              }}
            >
              <span className="select-toggle-label">{t("select_mode")}</span>
            </Button>
          )}
        </div>

        {/* Filters stay on screen: one click each, no popover. On the phone the
            source chips drop their words (tooltips keep them). */}
        <div className={`filter-row${phone ? " phone-filter-row" : ""}`}>
          <Segmented
            value={source}
            onChange={(val) => {
              setSource(val);
              setPage(0);
            }}
            options={[
              { value: "", label: t("filter_all") },
              { value: "upload", label: t("filter_upload"), icon: "uploaded", iconOnly: phone },
              { value: "generated", label: t("filter_output"), icon: "output", title: t("filter_output_hint"), iconOnly: phone },
              { value: "app", label: t("filter_in_app"), icon: "generated", iconOnly: phone },
              { value: "imported", label: t("filter_imported"), icon: "imported", iconOnly: phone },
            ]}
          />
          <Button
            className={`skip-toggle${starredOnly ? " on" : ""}`}
            icon="favorite"
            title={t("filter_starred_only")}
            aria-label={t("filter_starred_only")}
            aria-pressed={starredOnly}
            onClick={() => {
              setStarredOnly((v) => !v);
              setPage(0);
            }}
          >
            <span className="filter-label">{t("filter_starred_only")}</span>
          </Button>
          {phone && (
            <Button
              className={`skip-toggle phone-search-toggle${searchOpen || query ? " on" : ""}`}
              icon="search"
              title={t("search")}
              aria-label={t("search")}
              aria-pressed={searchOpen || !!query}
              onClick={() => {
                if (searchOpen || query) {
                  setSearchOpen(false);
                  setQuery("");
                  setPage(0);
                } else setSearchOpen(true);
              }}
            />
          )}
        </div>

        {/* Tag filter bar (collection-style) */}
        <TagFilterRow
          tags={tags}
          value={tagFilter}
          phone={phone}
          total={total}
          onChange={(id) => {
            setTagFilter(id);
            setPage(0);
          }}
        />

        {/* Batch tagging bar (desktop; on the phone it lives in a sheet). */}
        {!phone && selectMode && (
          <div className="batch-bar">
            <div className="batch-bar-row">
              <span className="batch-count">{t("selected_n", { n: selected.size })}</span>
              <Button
                variant="link"
                disabled={images.length === 0 || allSelected}
                onClick={selectAllOnPage}
              >
                {t("select_all")}
              </Button>
              {selected.size > 0 && (
                <Button variant="link" onClick={() => setSelected(new Set())}>
                  {t("deselect_all")}
                </Button>
              )}
              <div className="spacer" />
              <Button
                variant="primary"
                size="sm"
                icon="check"
                className="batch-done"
                title={t("done")}
                aria-label={t("done")}
                onClick={() => {
                  setSelectMode(false);
                  setSelected(new Set());
                  setBatchMode(null);
                }}
              >
                <span className="batch-btn-label">{t("done")}</span>
              </Button>
            </div>
            <div className="batch-bar-row">
              <div className="btn-group" role="group" aria-label={t("tags_label")}>
                <Button
                  size="sm"
                  icon="tag"
                  className={batchMode === "add" ? "on" : ""}
                  aria-pressed={batchMode === "add"}
                  title={t("batch_add_tag")}
                  aria-label={t("batch_add_tag")}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "add" ? null : "add")}
                >
                  <span className="batch-btn-label">{t("batch_add_tag")}</span>
                </Button>
                <Button
                  size="sm"
                  icon="untag"
                  className={batchMode === "remove" ? "on" : ""}
                  aria-pressed={batchMode === "remove"}
                  title={t("batch_remove_tag")}
                  aria-label={t("batch_remove_tag")}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "remove" ? null : "remove")}
                >
                  <span className="batch-btn-label">{t("batch_remove_tag")}</span>
                </Button>
              </div>
              <Button
                size="sm"
                icon="download"
                title={t("batch_download")}
                aria-label={t("batch_download")}
                disabled={selected.size === 0}
                onClick={downloadSelected}
              >
                <span className="batch-btn-label">{t("batch_download")}</span>
              </Button>
            </div>
          </div>
        )}
        {!phone && selectMode && batchMode && selected.size > 0 && (
          <div className="batch-tags">
            <div className="batch-section">
              <span className="batch-section-title">{t("apply_to_selected")}</span>
              <div className="tag-chip-row">
                {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    className="tag-chip"
                    onClick={() => applyBatch(tag.id)}
                  >
                    <Icon name={batchMode === "add" ? "add" : "remove"} size="sm" /> {tag.name}
                    <span className="tag-count">{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
            {batchMode === "add" && (
              <div className="batch-section">
                <span className="batch-section-title">{t("create_new_tag")}</span>
                <div className="tag-create">
                  <input
                    value={draft}
                    placeholder={t("new_tag_placeholder")}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        createAndApply();
                      }
                    }}
                  />
                  <button onClick={createAndApply} disabled={!draft.trim()}>
                    {t("create")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {phone ? phonePager : pager}
      </div>

      {loading ? (
        <p className="muted">
          <span className="spinner" /> {t("loading")}
        </p>
      ) : loadError ? (
        <div className="load-error">
          <span className="small">{t("load_error", { msg: loadError })}</span>
          <button onClick={load}>{t("retry")}</button>
        </div>
      ) : images.length === 0 ? (
        hasActiveFilters ? (
          <div className="empty-state">
            <p className="muted">{t("no_results")}</p>
            <button onClick={clearFilters}>{t("clear_filters")}</button>
          </div>
        ) : (
          <p className="muted">{t("lib_empty")}</p>
        )
      ) : (
        <div
          className={`grid library-grid${compact ? " compact" : " full"}${phone ? ` phone-grid phone-cols-${phoneColumns}` : ""}${
            phone && phoneColumns === 4 ? " cols-4" : ""
          }`}
          style={
            (compact
              ? { "--library-columns": effectiveColumns }
              : { "--thumb-min": THUMB_MIN[thumbSize] }) as Record<
              string,
              string | number
            > as CSSProperties
          }
        >
          {images.map((img) => {
            const tagNames = (img.tags ?? []).map((tg) => tg.name);
            return (
              <div
                className={`card lib-tile${selected.has(img.id) ? " selected" : ""}${selectMode ? " selecting" : ""}${
                  added === img.id ? " just-added" : ""
                }`}
                key={img.id}
                {...(!phone && !selectMode ? imageDragProps(img) : {})}
                onPointerDown={phone ? (e) => startLongPress(e, img) : undefined}
                onPointerMove={phone ? moveLongPress : undefined}
                onPointerUp={phone ? endLongPress : undefined}
                onPointerCancel={phone ? endLongPress : undefined}
                onPointerLeave={phone ? endLongPress : undefined}
              >
                <img
                  src={imgThumbUrl(img.id)}
                  alt={img.filename}
                  draggable={false}
                  title={[img.filename, ...tagNames].join(" · ")}
                  onClick={() => onCardClick(img)}
                  {...pressable(() => onCardClick(img))}
                />
                <span
                  className={`lib-source ${img.source}`}
                  title={img.source === "upload" ? t("tag_upload") : t("tag_generated")}
                >
                  <Icon name={img.source === "upload" ? "uploaded" : "generated"} size="sm" />
                </span>
                {!!img.starred && !selectMode && (
                  <span className="lib-starred" title={t("favorite")}>
                    <Icon name="favorite" size="sm" filled />
                  </span>
                )}
                {selectMode && (
                  <span className="select-check">
                    {selected.has(img.id) && <Icon name="check" size="sm" />}
                  </span>
                )}
                {tagNames.length > 0 && (
                  <div className="lib-tags">
                    {tagNames.slice(0, 2).map((name) => (
                      <span key={name} className="card-tag">{name}</span>
                    ))}
                    {tagNames.length > 2 && <span className="card-tag">+{tagNames.length - 2}</span>}
                  </div>
                )}
                {!selectMode && (
                  <div className="lib-actions">
                    <IconButton
                      variant="overlay"
                      icon="addToRefs"
                      label={t("add_ref")}
                      onClick={() => {
                        addToTray(img);
                        setAdded(img.id);
                        setTimeout(() => setAdded(null), 700);
                      }}
                    />
                    <div className="spacer" />
                    <IconButton
                      variant="overlay"
                      className={img.starred ? "is-starred" : ""}
                      icon="favorite"
                      filled={!!img.starred}
                      label={img.starred ? t("unfavorite") : t("favorite")}
                      aria-pressed={!!img.starred}
                      onClick={() => toggleStar(img)}
                    />
                    <IconButton variant="overlay" icon="download" label={t("download")} onClick={() => download(img)} />
                    <IconButton variant="overlay" icon="delete" label={t("delete")} onClick={() => remove(img)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!phone && pager}

      {phone && selectMode && (
        <nav className="phone-selbar" aria-label={t("apply_to_selected")}>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={useSelectedAsRefs}
          >
            <Icon name="addToRefs" />
            <span>{t("phone_use_as_ref")}</span>
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => {
              setBatchMode("add");
              setBatchSheet(true);
            }}
          >
            <Icon name="tag" />
            <span>{t("tags_label")}</span>
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={downloadSelected}
          >
            <Icon name="download" />
            <span>{t("batch_download")}</span>
          </button>
        </nav>
      )}

      {phone && batchSheet && (
        <Sheet
          title={t("phone_batch_tags")}
          onClose={() => setBatchSheet(false)}
          footer={
            <button
              type="button"
              className="btn primary"
              style={{ flex: 1 }}
              onClick={() => setBatchSheet(false)}
            >
              {t("done")}
            </button>
          }
        >
          <div className="sheet-field">
            <span className="lab">
              {t("apply_to_selected")} · {t("selected_n", { n: selected.size })}
            </span>
            <div className="phone-batch-mode">
              <button
                type="button"
                className={batchMode === "add" ? "on" : ""}
                onClick={() => setBatchMode("add")}
              >
                <Icon name="add" size="sm" />
                {t("batch_add_tag")}
              </button>
              <button
                type="button"
                className={batchMode === "remove" ? "on" : ""}
                onClick={() => setBatchMode("remove")}
              >
                <Icon name="remove" size="sm" />
                {t("batch_remove_tag")}
              </button>
            </div>
          </div>
          <div className="sheet-tag-wrap">
            {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="tag-chip"
                onClick={() => {
                  applyBatch(tag.id);
                  setBatchSheet(false);
                }}
              >
                <Icon name={batchMode === "remove" ? "remove" : "add"} size="sm" /> {tag.name}
                <span className="tag-count">{tag.count}</span>
              </button>
            ))}
          </div>
          {batchMode === "add" && (
            <div className="sheet-field">
              <span className="lab">{t("create_new_tag")}</span>
              <div className="tag-create">
                <input
                  value={draft}
                  placeholder={t("new_tag_placeholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      createAndApply().then(() => setBatchSheet(false));
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => createAndApply().then(() => setBatchSheet(false))}
                  disabled={!draft.trim()}
                >
                  {t("create")}
                </button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}
