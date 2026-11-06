import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, seriesApi, type SeriesImportPreview, type Tag } from "../api";
import { useBackLayer } from "../backStack";
import { useI18n } from "../i18n";
import { useSeries } from "../seriesStore";
import { SERIES_COLORS } from "./SeriesBits";
import { useToast } from "./Toast";

function SeriesModal({
  title,
  onClose,
  children,
  actions,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  busy?: boolean;
}) {
  useBackLayer(true, () => (busy ? false : onClose()));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);
  return createPortal(
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="modal series-modal" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="mt-0">{title}</h3>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}

const errorText = (e: unknown, t: (k: string, v?: Record<string, string | number>) => string) =>
  e instanceof ApiError && e.detail === "name_taken"
    ? t("series_name_taken")
    : t("op_failed", { msg: (e as Error).message });

function ColorRow({ value, onChange }: { value: string | null; onChange: (c: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="series-colors" role="radiogroup" aria-label={t("series_color")}>
      {SERIES_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className={`series-swatch${value === c ? " on" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function ThemeSelect({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useI18n();
  const { themes } = useSeries();
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{t("series_no_theme")}</option>
      {themes
        .filter((theme) => !theme.archived || theme.id === value)
        .map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
    </select>
  );
}

/** New theme, new series, or rename/recolor an existing one. */
export function SeriesEditDialog({
  mode,
  id,
  initialName = "",
  initialColor = null,
  initialTheme = null,
  onClose,
  onDone,
}: {
  mode: "new-theme" | "new-series" | "edit";
  id?: number;
  initialName?: string;
  initialColor?: string | null;
  initialTheme?: number | null;
  onClose: () => void;
  onDone?: (id: number) => void;
}) {
  const { t } = useI18n();
  const store = useSeries();
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<string | null>(initialColor);
  const [theme, setTheme] = useState<number | null>(initialTheme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isTheme = mode === "new-theme" || (mode === "edit" && store.themes.some((th) => th.id === id));

  const submit = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      let resultId: number;
      if (mode === "edit" && id) {
        await seriesApi.update(id, { name: clean, ...(color ? { color } : {}) });
        resultId = id;
      } else {
        const created = await seriesApi.create({
          kind: mode === "new-theme" ? "theme" : "series",
          name: clean,
          parentId: mode === "new-series" ? theme : null,
          color,
        });
        resultId = created.id;
        if (mode === "new-series") store.markRecent(created.id);
      }
      await store.reload();
      onDone?.(resultId);
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "new-theme" ? t("series_new_theme") : mode === "new-series" ? t("series_new_series") : t("series_rename");
  return (
    <SeriesModal
      title={title}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>{t("cancel")}</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {mode === "edit" ? t("save") : t("series_create")}
          </button>
        </>
      }
    >
      <label htmlFor="series-name">{isTheme ? t("series_theme_name") : t("series_name")}</label>
      <input
        id="series-name"
        autoFocus
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {mode === "new-series" && (
        <div className="mt-4">
          <label>{t("series_theme")}</label>
          <ThemeSelect value={theme} onChange={setTheme} />
        </div>
      )}
      <div className="mt-4">
        <label>{t("series_color")}</label>
        <ColorRow value={color} onChange={setColor} />
      </div>
      {error && <p className="series-form-error">{error}</p>}
    </SeriesModal>
  );
}

/** Move a series under a theme (or to "No theme"). */
export function MoveToThemeDialog({
  id,
  current,
  onClose,
}: {
  id: number;
  current: number | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const store = useSeries();
  const [theme, setTheme] = useState<number | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await seriesApi.update(id, { parentId: theme });
      await store.reload();
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SeriesModal
      title={t("series_move_to_theme")}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>{t("cancel")}</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || theme === current}>
            {t("series_move")}
          </button>
        </>
      }
    >
      <label>{t("series_theme")}</label>
      <ThemeSelect value={theme} onChange={setTheme} />
      {error && <p className="series-form-error">{error}</p>}
    </SeriesModal>
  );
}

/** ③ "New series from a tag": preview, then create + assign. */
export function ImportFromTagDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone?: (id: number) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const store = useSeries();
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagId, setTagId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [theme, setTheme] = useState<number | null>(null);
  const [includeFailed, setIncludeFailed] = useState(true);
  const [preview, setPreview] = useState<SeriesImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listTags().then((r) => setTags(r.tags)).catch(() => setTags([]));
  }, []);

  useEffect(() => {
    if (tagId === null) {
      setPreview(null);
      return;
    }
    let alive = true;
    setLoading(true);
    seriesApi
      .importPreview(tagId)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(errorText(e, t)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tagId, t]);

  const tag = tags.find((tg) => tg.id === tagId) ?? null;
  const total = preview ? preview.found + (includeFailed ? preview.failedSamePrompt : 0) : 0;
  const moving = preview ? preview.inOtherSeries + (includeFailed ? preview.failedInOtherSeries : 0) : 0;

  const submit = async () => {
    if (tagId === null || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await seriesApi.importFromTag({ tagId, name: name.trim(), parentId: theme, includeFailed });
      store.markRecent(res.series.id);
      await store.reload();
      toast(t("series_import_done", { n: res.assigned, name: res.series.name }), "success");
      onDone?.(res.series.id);
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SeriesModal
      title={t("series_import_title")}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || loading || !preview || total === 0 || !name.trim()}
          >
            {t("series_import_create", { n: total })}
          </button>
        </>
      }
    >
      <p className="series-modal-desc">{t("series_import_desc")}</p>
      <label htmlFor="series-import-tag">{t("series_import_tag")}</label>
      <div className="series-import-tag">
        <select
          id="series-import-tag"
          autoFocus
          value={tagId ?? ""}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            setTagId(id);
            const picked = tags.find((tg) => tg.id === id);
            if (picked && !nameTouched) setName(picked.name);
          }}
        >
          <option value="">{t("series_import_pick_tag")}</option>
          {tags.map((tg) => (
            <option key={tg.id} value={tg.id}>
              {tg.name}
            </option>
          ))}
        </select>
        {tag && <span className="series-import-count">{t("series_import_images", { n: tag.count })}</span>}
      </div>
      <div className="series-modal-row mt-4">
        <div>
          <label htmlFor="series-import-name">{t("series_name")}</label>
          <input
            id="series-import-name"
            value={name}
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </div>
        <div>
          <label>{t("series_theme")}</label>
          <ThemeSelect value={theme} onChange={setTheme} />
        </div>
      </div>
      {preview && (
        <div className="series-import-summary">
          <div className="series-import-line">
            <span>{t("series_import_found")}</span>
            <strong>{preview.found}</strong>
          </div>
          <div className="series-import-line">
            <span className="muted">{t("series_import_moving")}</span>
            <span className={moving > 0 ? "series-import-warn" : "muted"}>{moving}</span>
          </div>
          <label className="series-import-check">
            <input
              type="checkbox"
              checked={includeFailed && preview.failedSamePrompt > 0}
              disabled={preview.failedSamePrompt === 0}
              onChange={(e) => setIncludeFailed(e.target.checked)}
            />
            <span>{t("series_import_failed")}</span>
            <span className="muted">(+{preview.failedSamePrompt})</span>
          </label>
        </div>
      )}
      {loading && !preview && <p className="muted small">{t("loading")}</p>}
      {error && <p className="series-form-error">{error}</p>}
    </SeriesModal>
  );
}
