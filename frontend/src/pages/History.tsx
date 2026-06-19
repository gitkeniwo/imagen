import { type CSSProperties, useEffect, useState } from "react";
import { api, Generation, ImageRow, Tag, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import SearchBox from "../components/SearchBox";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
const PROMPT_PREVIEW_CHARS = 160;
const PROMPT_PREVIEW_LINES = 3;
const HISTORY_COLUMNS_KEY = "imagen-history-columns";
const HISTORY_COLUMN_OPTIONS = [1, 2];
const HISTORY_COLUMN_OPTIONS_FULL = [1, 2, 3];

function initialHistoryColumns() {
  const saved = Number(localStorage.getItem(HISTORY_COLUMNS_KEY));
  return HISTORY_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
}

export default function History({
  onReuse,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
}: {
  onReuse: (g: Generation) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
}) {
  const { t, reason } = useI18n();
  const [gens, setGens] = useState<Generation[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [columns, setColumns] = useState(initialHistoryColumns);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.listGenerations({
        limit: pageSize,
        offset: page * pageSize,
        tag: tagFilter ?? undefined,
        q: query || undefined,
      }),
      api.listTags(),
    ])
      .then(([r, tagsRes]) => {
        setGens(r.generations);
        setTotal(r.total);
        setTags(tagsRes.tags);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .finally(() => setLoading(false));
  }, [page, pageSize, tagFilter, query, refreshKey]);

  useEffect(() => {
    localStorage.setItem(HISTORY_COLUMNS_KEY, String(columns));
  }, [columns]);

  const toggleExpand = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  // All output images on this page, for viewer prev/next navigation.
  const pageOutputs = gens
    .map((g) => g.outputImage)
    .filter((o): o is ImageRow => !!o);

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

  const tagBar = (
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
  );

  // Collect unique tags from all images in a generation (inputs + output).
  const genTags = (g: Generation) => {
    const all = [...(g.inputs ?? []), ...(g.outputImage ? [g.outputImage] : [])];
    const seen = new Set<number>();
    return all.flatMap((im) => im.tags ?? []).filter((tg) => {
      if (seen.has(tg.id)) return false;
      seen.add(tg.id);
      return true;
    });
  };

  return (
    <div>
      <div className="history-toolbar">
        <div className="history-toolbar-row">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
              setPage(0);
            }}
            placeholder={t("search_placeholder_history")}
          />
          <div className="seg density-seg history-cols-seg" title={t("columns_per_row")}>
            {(compact ? HISTORY_COLUMN_OPTIONS : HISTORY_COLUMN_OPTIONS_FULL).map((n) => (
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
        {tagBar}
      </div>
      {pager}

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : gens.length === 0 ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          {query || tagFilter !== null ? (
            <div className="empty-state">
              <span>{t("no_results")}</span>
              <button
                onClick={() => {
                  setQuery("");
                  setTagFilter(null);
                  setPage(0);
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("history_empty")
          )}
        </div>
      ) : (
        <div
          className={`history-list${compact ? " compact" : ""}`}
          style={{ "--history-columns": columns } as CSSProperties}
        >
          {gens.map((g) => (
            <div className="panel history-panel" key={g.id}>
              <div className="history-meta">
                <span className={`badge ${g.status}`}>{t(`status_${g.status}`)}</span>
                <span className="muted small">{g.model}</span>
                {g.aspect_ratio && <span className="muted small">· {g.aspect_ratio}</span>}
                {g.resolution && <span className="muted small">· {g.resolution}</span>}
                <div className="spacer" style={{ flex: 1 }} />
                <button onClick={() => onReuse(g)}>{t("reuse")}</button>
              </div>

              {g.prompt && (
                <div className="history-prompt-wrap">
                  <p
                    className={`history-prompt${
                      expanded.has(g.id) ? " expanded" : ""
                    }`}
                  >
                    {g.prompt}
                  </p>
                  {(g.prompt.length > PROMPT_PREVIEW_CHARS ||
                    g.prompt.split(/\r?\n/).length > PROMPT_PREVIEW_LINES) && (
                    <button
                      className="link-btn history-prompt-toggle"
                      onClick={() => toggleExpand(g.id)}
                    >
                      {expanded.has(g.id) ? t("show_less") : t("show_more")}
                    </button>
                  )}
                </div>
              )}

              {genTags(g).length > 0 && (
                <div className="card-tags" style={{ marginBottom: 8 }}>
                  {genTags(g).map((tg) => (
                    <span key={tg.id} className="card-tag">
                      {tg.name}
                    </span>
                  ))}
                </div>
              )}

              <div className="gen-row">
                <div className="gen-inputs">
                  {(g.inputs ?? []).map((im) =>
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
                        title={im.filename}
                        onClick={() => onOpenViewer(im, g.inputs ?? [])}
                      />
                    ),
                  )}
                  {(g.inputs ?? []).length === 0 && (
                    <span className="muted small">{t("no_refs")}</span>
                  )}
                </div>
                <span className="arrow">→</span>
                <div className="gen-out">
                  {g.outputImage?.deleted_at ||
                  (g.status === "success" && !g.outputImage) ? (
                    <div className="deleted-tile output">
                      <i className="fa-solid fa-trash-can" />
                      <span className="small">{t("deleted_label")}</span>
                    </div>
                  ) : g.outputImage ? (
                    <div>
                      <img
                        src={imgThumbUrl(g.outputImage.id)}
                        alt="output"
                        title={t("open_viewer")}
                        onClick={() => onOpenViewer(g.outputImage!, pageOutputs)}
                      />
                      {g.outputImage.tags && g.outputImage.tags.length > 0 && (
                        <div className="card-tags">
                          {g.outputImage.tags.map((tg) => (
                            <span key={tg.id} className="card-tag">
                              {tg.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      className={`notice ${
                        g.status === "blocked"
                          ? "blocked"
                          : g.status === "aborted"
                          ? "aborted"
                          : "error"
                      } small`}
                    >
                      {reason(g.raw_finish) || g.error_message || t("no_output")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pager}
    </div>
  );
}
