import { type CSSProperties, useEffect, useState } from "react";
import { api, Generation, ImageRow, Tag, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;

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
  }, [page, pageSize, tagFilter, refreshKey]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  // All output images on this page, for viewer prev/next navigation.
  const pageOutputs = gens
    .map((g) => g.outputImage)
    .filter((o): o is ImageRow => !!o);

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

  return (
    <div>
      {tagBar}

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : gens.length === 0 ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          {t("history_empty")}
        </div>
      ) : (
        <div className={`history-list${compact ? " compact" : ""}`}>
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

              {g.prompt && <p style={{ marginTop: 0 }}>{g.prompt}</p>}

              <div className="gen-row">
                <div className="gen-inputs">
                  {(g.inputs ?? []).map((im) => (
                    <img
                      key={im.id}
                      src={imgThumbUrl(im.id)}
                      alt={im.filename}
                      title={im.filename}
                      onClick={() => onOpenViewer(im, g.inputs ?? [])}
                    />
                  ))}
                  {(g.inputs ?? []).length === 0 && (
                    <span className="muted small">{t("no_refs")}</span>
                  )}
                </div>
                <span className="arrow">→</span>
                <div className="gen-out">
                  {g.outputImage ? (
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
                    <div className={`notice ${g.status === "blocked" ? "blocked" : "error"} small`}>
                      {reason(g.raw_finish) || g.error_message || t("no_output")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {hasPages && (
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
      )}
    </div>
  );
}
