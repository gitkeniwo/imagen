import { type CSSProperties, useEffect, useState } from "react";
import { api, downloadName, ImageRow, Tag, batchDownloadUrl, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import { imageDragProps } from "../imageDrag";
import { pageSizedToColumns } from "../pageSize";
import SearchBox from "../components/SearchBox";
import TagFilterRow from "../components/TagFilterRow";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import Icon from "../components/ui/Icon";
import { Button, IconButton } from "../components/ui/Button";
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
}: {
  addToTray: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [source, setSource] = useState<string>("");
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
  // Compact grid columns are fixed, so the page must hold whole rows; the full
  // grid uses auto-fill and stays on a fixed page size.
  const pageSize = compact
    ? pageSizedToColumns(COMPACT_PAGE_SIZE, columns)
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
    if (selectMode) toggleSelect(img.id);
    else onOpenViewer(img, images);
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

  return (
    <div className={`panel library-panel${compact ? " compact" : ""}`}>
      <div className="library-sticky">
        <div className="library-toolbar">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
              setPage(0);
            }}
            placeholder={t("search_placeholder_library")}
          />
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
          {!selectMode && (
            <Button
              className="select-toggle"
              icon="selectMode"
              onClick={() => {
                setSelectMode(true);
                setSelected(new Set());
                setBatchMode(null);
              }}
            >
              {t("select_mode")}
            </Button>
          )}
        </div>

        {/* Filters stay on screen: one click each, no popover. */}
        <div className="filter-row">
          <Segmented
            value={source}
            onChange={(val) => {
              setSource(val);
              setPage(0);
            }}
            options={[
              { value: "", label: t("filter_all") },
              { value: "upload", label: t("filter_upload"), icon: "uploaded" },
              { value: "generated", label: t("filter_output"), icon: "output", title: t("filter_output_hint") },
              { value: "app", label: t("filter_in_app"), icon: "generated" },
              { value: "imported", label: t("filter_imported"), icon: "imported" },
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
        </div>

        {/* Tag filter bar (collection-style) */}
        <TagFilterRow
          tags={tags}
          value={tagFilter}
          onChange={(id) => {
            setTagFilter(id);
            setPage(0);
          }}
        />

        {/* Batch tagging bar (only in select mode with a selection) */}
        {selectMode && (
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
                onClick={() => {
                  setSelectMode(false);
                  setSelected(new Set());
                  setBatchMode(null);
                }}
              >
                {t("done")}
              </Button>
            </div>
            <div className="batch-bar-row">
              <div className="btn-group" role="group" aria-label={t("tags_label")}>
                <Button
                  size="sm"
                  icon="tag"
                  className={batchMode === "add" ? "on" : ""}
                  aria-pressed={batchMode === "add"}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "add" ? null : "add")}
                >
                  {t("batch_add_tag")}
                </Button>
                <Button
                  size="sm"
                  icon="untag"
                  className={batchMode === "remove" ? "on" : ""}
                  aria-pressed={batchMode === "remove"}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "remove" ? null : "remove")}
                >
                  {t("batch_remove_tag")}
                </Button>
              </div>
              <Button size="sm" icon="download" disabled={selected.size === 0} onClick={downloadSelected}>
                {t("batch_download")}
              </Button>
            </div>
          </div>
        )}
        {selectMode && batchMode && selected.size > 0 && (
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

        {pager}
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
          className={`grid library-grid${compact ? " compact" : " full"}`}
          style={
            (compact
              ? { "--library-columns": columns }
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
                {...(selectMode ? {} : imageDragProps(img))}
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
      {pager}
    </div>
  );
}
