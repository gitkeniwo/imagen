import { ASPECT_RATIOS, MODELS, OUTPUT_FORMATS, RESOLUTIONS } from "../api";
import { useI18n } from "../i18n";
import CustomSelect from "./CustomSelect";
import Segmented from "./ui/Segmented";

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
          <CustomSelect
            value={model}
            onChange={setModel}
            options={MODELS.map((m) => ({ id: m.id, label: m.label }))}
          />
        </div>
        <div>
          <label>
            {t("resolution")}
            {!isPro && t("pro_only")}
          </label>
          <Segmented
            value={resolution}
            onChange={setResolution}
            disabled={!isPro}
            options={RESOLUTIONS.map((r) => ({ value: r, label: r }))}
          />
        </div>
        <div>
          <label>{t("format")}</label>
          <Segmented
            value={format}
            onChange={setFormat}
            options={OUTPUT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
          />
        </div>
      </div>

      <div className="mt-4">
        <label>{t("aspect")}</label>
        <div className="aspect-row">
          {ASPECT_RATIOS.map((r) => {
            const [w, h] = r.split(":").map(Number);
            return (
              <button
                key={r}
                className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
                aria-pressed={aspectRatio === r}
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
