import { useEffect, useState } from "react";
import { api, Generation, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;

export default function History({
  onReuse,
  compact = false,
  refreshKey = 0,
}: {
  onReuse: (g: Generation) => void;
  compact?: boolean;
  refreshKey?: number;
}) {
  const { t, reason } = useI18n();
  const [gens, setGens] = useState<Generation[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

  useEffect(() => {
    setLoading(true);
    api
      .listGenerations({ limit: pageSize, offset: page * pageSize })
      .then((r) => {
        setGens(r.generations);
        setTotal(r.total);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .finally(() => setLoading(false));
  }, [page, pageSize, refreshKey]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  if (loading)
    return (
      <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
        <span className="spinner" /> {t("loading")}
      </div>
    );
  if (gens.length === 0)
    return (
      <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
        {t("history_empty")}
      </div>
    );

  return (
    <div>
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

            {g.prompt && (
              <p style={{ marginTop: 0 }}>{g.prompt}</p>
            )}

            <div className="gen-row">
              <div className="gen-inputs">
                {(g.inputs ?? []).map((im) => (
                  <img key={im.id} src={imgThumbUrl(im.id)} alt={im.filename} title={im.filename} />
                ))}
                {(g.inputs ?? []).length === 0 && (
                  <span className="muted small">{t("no_refs")}</span>
                )}
              </div>
              <span className="arrow">→</span>
              <div className="gen-out">
                {g.outputImage ? (
                  <a href={imgFileUrl(g.outputImage.id)} target="_blank" rel="noreferrer">
                    <img src={imgThumbUrl(g.outputImage.id)} alt="output" />
                  </a>
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
