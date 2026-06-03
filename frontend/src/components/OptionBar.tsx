import { ASPECT_RATIOS, MODELS, OUTPUT_FORMATS, RESOLUTIONS } from "../api";
import { useI18n } from "../i18n";

export default function OptionBar({
  model,
  setModel,
  aspectRatio,
  setAspectRatio,
  resolution,
  setResolution,
  format,
  setFormat,
}: {
  model: string;
  setModel: (v: string) => void;
  aspectRatio: string;
  setAspectRatio: (v: string) => void;
  resolution: string;
  setResolution: (v: string) => void;
  format: string;
  setFormat: (v: string) => void;
}) {
  const { t } = useI18n();
  const isPro = MODELS.find((m) => m.id === model)?.pro ?? false;

  return (
    <div>
      <div className="row">
        <div>
          <label>{t("model")}</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>
            {t("resolution")}
            {!isPro && t("pro_only")}
          </label>
          <div className="seg">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                className={resolution === r ? "on" : ""}
                disabled={!isPro}
                onClick={() => setResolution(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label>{t("format")}</label>
          <div className="seg">
            {OUTPUT_FORMATS.map((f) => (
              <button
                key={f.id}
                className={format === f.id ? "on" : ""}
                onClick={() => setFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label>{t("aspect")}</label>
        <div className="aspect-row">
          {ASPECT_RATIOS.map((r) => {
            const [w, h] = r.split(":").map(Number);
            return (
              <button
                key={r}
                className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
                onClick={() => setAspectRatio(r)}
                title={r}
              >
                <span className="aspect-shape" style={{ aspectRatio: `${w} / ${h}` }} />
                <span className="aspect-label">{r}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
