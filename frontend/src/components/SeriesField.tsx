import { useState } from "react";
import { useI18n } from "../i18n";
import { seriesPathText, useSeries } from "../seriesStore";
import { SeriesDot } from "./SeriesBits";
import SeriesPicker from "./SeriesPicker";
import Icon from "./ui/Icon";
import Popover from "./ui/Popover";

/** Composer "Series" row: one-line pill + picker anchored to its left edge. */
export default function SeriesField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { t } = useI18n();
  const store = useSeries();
  const [open, setOpen] = useState(false);
  const path = store.get(value);
  const node = store.node(value);
  const noTheme = t("series_no_theme");

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
            className={`series-pill${path ? " on" : ""}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            title={path ? seriesPathText(path, noTheme) : t("series_none_hint")}
            onClick={() => setOpen((v) => !v)}
          >
            {path ? (
              <>
                <SeriesDot color={path.color} />
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
          noneLabel={t("series_none_for_workspace")}
          onClose={() => setOpen(false)}
        />
      </Popover>
      {node && (
        <span className="series-field-meta">{t("series_tries_so_far", { n: node.tries })}</span>
      )}
    </div>
  );
}
