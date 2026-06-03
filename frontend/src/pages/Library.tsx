import { type CSSProperties, useEffect, useState } from "react";
import { api, ImageRow, imgThumbUrl } from "../api";
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
  compact = false,
  refreshKey = 0,
}: {
  addToTray: (img: ImageRow) => void;
  compact?: boolean;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [source, setSource] = useState<string>("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [added, setAdded] = useState<number | null>(null);
  const [columns, setColumns] = useState(initialGridColumns);
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

  const load = () => {
    setLoading(true);
    api
      .listImages({
        limit: pageSize,
        offset: page * pageSize,
        source: source || undefined,
      })
      .then((r) => {
        setImages(r.images);
        setTotal(r.total);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [source, page, pageSize, refreshKey]);

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

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

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
        <span className="muted small library-hint">
          {t("lib_hint")}
        </span>
      </div>
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
            <div className="card" key={img.id}>
              <img
                src={imgThumbUrl(img.id)}
                alt={img.filename}
                title={t("add_ref")}
                onClick={() => {
                  addToTray(img);
                  setAdded(img.id);
                  setTimeout(() => setAdded(null), 700);
                }}
                style={added === img.id ? { outline: "3px solid var(--accent)" } : undefined}
              />
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
