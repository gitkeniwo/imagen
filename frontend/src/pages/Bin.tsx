import { useEffect, useState } from "react";
import { api, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const PAGE_SIZE = 60;

// Recycle bin: browse soft-deleted images, restore them, or purge permanently.
export default function Bin({
  onOpenViewer,
  refreshKey = 0,
  onChanged,
}: {
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .listBin({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((r) => {
        setImages(r.images);
        setTotal(r.total);
        if (r.total > 0 && page * PAGE_SIZE >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1));
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, refreshKey]);

  const restore = async (img: ImageRow) => {
    await api.restoreImage(img.id);
    load();
    onChanged?.();
  };

  const purge = async (img: ImageRow) => {
    if (!window.confirm(t("confirm_purge"))) return;
    await api.purgeImage(img.id);
    load();
    onChanged?.();
  };

  const emptyBin = async () => {
    if (!window.confirm(t("confirm_empty_bin"))) return;
    await api.emptyBin();
    load();
    onChanged?.();
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasPages = total > PAGE_SIZE;

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
    <div className="panel library-panel">
      <div className="bin-toolbar">
        <span className="muted small">{t("bin_hint")}</span>
        <div className="spacer" style={{ flex: 1 }} />
        {total > 0 && (
          <button className="danger-btn" onClick={emptyBin}>
            <i className="fa-solid fa-trash-can" /> {t("empty_bin")}
          </button>
        )}
      </div>

      {pager}

      {loading ? (
        <p className="muted">
          <span className="spinner" /> {t("loading")}
        </p>
      ) : images.length === 0 ? (
        <p className="muted">{t("bin_empty_state")}</p>
      ) : (
        <div className="grid library-grid full" style={{ "--thumb-min": "170px" } as React.CSSProperties}>
          {images.map((img) => (
            <div className="card" key={img.id}>
              <div className="card-img-wrap">
                <img
                  src={imgThumbUrl(img.id)}
                  alt={img.filename}
                  title={t("open_viewer")}
                  onClick={() => onOpenViewer(img, images)}
                />
              </div>
              <div className="meta bin-meta">
                <button className="bin-restore" title={t("restore")} onClick={() => restore(img)}>
                  <i className="fa-solid fa-rotate-left" /> {t("restore")}
                </button>
                <button className="bin-purge" title={t("delete_forever")} onClick={() => purge(img)}>
                  <i className="fa-solid fa-trash-can" /> {t("delete_forever")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pager}
    </div>
  );
}
