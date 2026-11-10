import { useState } from "react";
import { seriesApi } from "../api";
import { useI18n } from "../i18n";
import { seriesPathText, useSeries } from "../seriesStore";
import { SeriesDot } from "./SeriesBits";
import SeriesPicker from "./SeriesPicker";
import { useToast } from "./Toast";
import Icon from "./ui/Icon";
import Popover from "./ui/Popover";

/** Composer "Series" row: one-line pill + picker anchored to its left edge. */
export default function SeriesField({
  value,
  onChange,
  context = "composer",
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Composer context also explains what the archive means for the next try. */
  context?: "composer" | "record" | "draft";
}) {
  const { t } = useI18n();
  const toast = useToast();
  const store = useSeries();
  const [open, setOpen] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);
  const path = store.get(value);
  const node = store.node(value);
  const noTheme = t("series_no_theme");
  const archived = !!path?.archived;

  const unarchive = async () => {
    if (!value || unarchiving) return;
    setUnarchiving(true);
    try {
      await seriesApi.update(value, { archived: false });
      await store.reload();
      toast(t("series_unarchived_toast"));
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    } finally {
      setUnarchiving(false);
    }
  };

  return (
    <div className="series-field">
      <Popover
        fixed
        align="start"
        open={open}
        onClose={() => setOpen(false)}
        panelClassName="series-popover"
        panelProps={{ role: "dialog", "aria-label": t("series_pick") }}
        trigger={
          <button
            type="button"
            className={`series-pill${path ? " on" : ""}${archived ? " archived" : ""}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            title={path ? seriesPathText(path, noTheme) : t("series_none_hint")}
            onClick={() => setOpen((v) => !v)}
          >
            {path ? (
              <>
                {archived ? <Icon name="archive" size="sm" /> : <SeriesDot color={path.color} />}
                <span className="series-pill-text">
                  {path.theme && <span className="series-pill-theme">{path.theme.name} /</span>}
                  <span className="series-pill-name">{path.name}</span>
                </span>
              </>
            ) : (
              <span className="series-pill-text series-pill-empty">{t("series_none")}</span>
            )}
            <Icon name="chevronDown" size="sm" />
          </button>
        }
      >
        <SeriesPicker
          value={path ? value : null}
          onPick={(id) => onChange(id)}
          noneLabel={
            context === "composer" ? t("series_none_for_workspace") : t("series_none")
          }
          onClose={() => setOpen(false)}
        />
      </Popover>
      {archived && (
        <span className="series-field-archived">
          {context === "composer" ? t("series_archived_here") : t("series_archived")}
          <button
            type="button"
            className="series-field-unarchive"
            disabled={unarchiving}
            onClick={() => void unarchive()}
          >
            {t("series_unarchive")}
          </button>
        </span>
      )}
      {!archived && node && context === "composer" && (
        <span className="series-field-meta">{t("series_tries_so_far", { n: node.tries })}</span>
      )}
    </div>
  );
}
