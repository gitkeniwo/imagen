import { type CSSProperties, useEffect, useState } from "react";
import { api, ImageRow, Tag, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const COMPACT_PAGE_SIZE = 24;
const FULL_PAGE_SIZE = 60;
const GRID_COLUMNS_KEY = "imagen-library-columns";
const GRID_COLUMN_OPTIONS = [1, 2, 3, 4, 5];

function initialGridColumns() {
  const saved = Number(localStorage.getItem(GRID_COLUMNS_KEY));
  return GRID_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

export default function Library({
  addToTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
}: {
  addToTray: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [source, setSource] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [added, setAdded] = useState<number | null>(null);
  const [columns, setColumns] = useState(initialGridColumns);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchMode, setBatchMode] = useState<"add" | "remove" | null>(null);
  const [draft, setDraft] = useState("");
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

  const load = () => {
    setLoading(true);
    Promise.all([
      api.listImages({
        limit: pageSize,
        offset: page * pageSize,
        source: source || undefined,
        tag: tagFilter ?? undefined,
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
      .finally(() => setLoading(false));
  };

  useEffect(load, [source, tagFilter, page, pageSize, refreshKey]);

  useEffect(() => {
    localStorage.setItem(GRID_COLUMNS_KEY, String(columns));
  }, [columns]);

  const toggleStar = async (img: ImageRow) => {
    await api.patchImage(img.id, { starred: !img.starred });
    load();
  };

  const remove = async (img: ImageRow) => {
    try {
      await api.deleteImage(img.id);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const onCardClick = (img: ImageRow) => {
    if (selectMode) toggleSelect(img.id);
    else onOpenViewer(img, images);
  };

  const applyBatch = async (tagId: number) => {
    if (!batchMode || selected.size === 0) return;
    await api.batchTag([...selected], [tagId], batchMode);
    load();
  };

  const downloadSelected = () => {
    for (const id of selected) {
      const a = document.createElement("a");
      a.href = imgFileUrl(id);
      a.download = "";
      a.click();
    }
  };

  const createAndApply = async () => {
    const name = draft.trim();
    if (!name) return;
    const tag = await api.createTag(name);
    setDraft("");
    if (selected.size > 0) await api.batchTag([...selected], [tag.id], "add");
    load();
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
      <div className="library-toolbar">
        <div className="library-filters">
          <div className="seg">
            {[
              ["", t("filter_all")],
              ["upload", t("filter_upload")],
              ["generated", t("filter_generated")],
            ].map(([val, label]) => (
              <button
                key={val}
                className={source === val ? "on" : ""}
                onClick={() => {
                  setSource(val);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          className={`select-toggle${selectMode ? " on" : ""}`}
          onClick={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
            setBatchMode(null);
          }}
        >
          {selectMode ? t("done") : t("select_mode")}
        </button>
      </div>

      {/* Tag filter bar (collection-style) */}
      <div className="tag-filter-row">
        <button
          className={`tag-chip${tagFilter === null ? " on" : ""}`}
          onClick={() => {
            setTagFilter(null);
            setPage(0);
          }}
        >
          {t("tags_all")}
        </button>
        {tags.map((tag) => (
          <button
            key={tag.id}
            className={`tag-chip${tagFilter === tag.id ? " on" : ""}`}
            style={tag.color ? ({ "--tag-color": tag.color } as CSSProperties) : undefined}
            onClick={() => {
              setTagFilter(tag.id);
              setPage(0);
            }}
          >
            {tag.name}
            <span className="tag-count">{tag.count}</span>
          </button>
        ))}
      </div>

      {/* Batch tagging bar (only in select mode with a selection) */}
      {selectMode && (
        <div className="batch-bar">
          <span className="small">{t("selected_n", { n: selected.size })}</span>
          <button
            className={batchMode === "add" ? "on" : ""}
            disabled={selected.size === 0}
            onClick={() => setBatchMode(batchMode === "add" ? null : "add")}
          >
            {t("batch_add_tag")}
          </button>
          <button
            className={batchMode === "remove" ? "on" : ""}
            disabled={selected.size === 0}
            onClick={() => setBatchMode(batchMode === "remove" ? null : "remove")}
          >
            {t("batch_remove_tag")}
          </button>
          <button
            disabled={selected.size === 0}
            onClick={downloadSelected}
          >
            {t("batch_download")}
          </button>
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())}>{t("clear_sel")}</button>
          )}
        </div>
      )}
      {selectMode && batchMode && selected.size > 0 && (
        <div className="batch-tags">
          <div className="tag-chip-row">
            {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
            {tags.map((tag) => (
              <button
                key={tag.id}
                className="tag-chip"
                onClick={() => applyBatch(tag.id)}
              >
                {batchMode === "add" ? "＋" : "－"} {tag.name}
                <span className="tag-count">{tag.count}</span>
              </button>
            ))}
          </div>
          {batchMode === "add" && (
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
          )}
        </div>
      )}

      {pager}

      <div className="library-density">
        <span className="muted small">{t("columns_per_row")}</span>
        <div className="seg density-seg">
          {GRID_COLUMN_OPTIONS.map((n) => (
            <button
              key={n}
              className={columns === n ? "on" : ""}
              onClick={() => setColumns(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="muted">
          <span className="spinner" /> {t("loading")}
        </p>
      ) : images.length === 0 ? (
        <p className="muted">{t("lib_empty")}</p>
      ) : (
        <div
          className={`grid library-grid${compact ? " compact" : ""}`}
          style={{ "--library-columns": columns } as CSSProperties}
        >
          {images.map((img) => (
            <div
              className={`card${selected.has(img.id) ? " selected" : ""}`}
              key={img.id}
            >
              <div className="card-img-wrap">
                <img
                  src={imgThumbUrl(img.id)}
                  alt={img.filename}
                  title={selectMode ? t("select_mode") : t("open_viewer")}
                  onClick={() => onCardClick(img)}
                  style={
                    added === img.id ? { outline: "3px solid var(--accent)" } : undefined
                  }
                />
                {selectMode && (
                  <span className="select-check">{selected.has(img.id) ? "✓" : ""}</span>
                )}
                <button
                  className="add-input-btn"
                  title={t("add_ref")}
                  onClick={(e) => {
                    e.stopPropagation();
                    addToTray(img);
                    setAdded(img.id);
                    setTimeout(() => setAdded(null), 700);
                  }}
                >
                  ＋
                </button>
              </div>
              {img.tags && img.tags.length > 0 && (
                <div className="card-tags">
                  {img.tags.map((tg) => (
                    <span key={tg.id} className="card-tag">
                      {tg.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="meta">
                <span className="tag">
                  {img.source === "upload" ? t("tag_upload") : t("tag_generated")}
                </span>
                <span style={{ display: "flex", gap: 2 }}>
                  <button className="star" title={t("star")} onClick={() => toggleStar(img)}>
                    {img.starred ? "★" : "☆"}
                  </button>
                  <button className="star" title={t("delete")} onClick={() => remove(img)}>
                    🗑
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {pager}
    </div>
  );
}
