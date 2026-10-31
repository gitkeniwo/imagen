import { MODEL_LABELS, OUTPUT_FORMATS, ProviderId } from "../api";
import { useProviders } from "../useProviders";
import { useI18n } from "../i18n";
import CustomSelect from "./CustomSelect";
import Segmented from "./ui/Segmented";
import { AspectShape } from "./ComposerControls";

export default function OptionBar({
  provider,
  model,
  setModel,
  aspectRatio,
  setAspectRatio,
  resolution,
  setResolution,
  format,
  setFormat,
}: {
  provider: ProviderId;
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
  const { info, spec: specOf, providers } = useProviders();
  const models = info(provider)?.models ?? [];
  const spec = specOf(provider, model);
  const isPro = (spec?.resolutions.length ?? 0) > 0;
  const resolutions = isPro
    ? spec!.resolutions
    : [...new Set(providers.flatMap((p) => p.models.flatMap((m) => m.resolutions)))];
  const formats = OUTPUT_FORMATS.filter((f) => spec?.outputFormats.includes(f.id) ?? true);

  return (
    <div>
      <div className="row">
        <div>
          <label>{t("model")}</label>
          <CustomSelect
            value={model}
            onChange={setModel}
            options={models.map((m) => ({ id: m.id, label: MODEL_LABELS[m.id] ?? m.label }))}
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
            options={resolutions.map((r) => ({ value: r, label: r }))}
          />
        </div>
        <div>
          <label>{t("format")}</label>
          <Segmented
            value={format}
            onChange={setFormat}
            options={formats.map((f) => ({ value: f.id, label: f.label }))}
          />
        </div>
      </div>

      <div className="mt-4">
        <label>{t("aspect")}</label>
        <div className="aspect-row">
          {(spec?.aspectRatios ?? []).map((r) => {
            return (
              <button
                key={r}
                className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
                aria-pressed={aspectRatio === r}
                onClick={() => setAspectRatio(r)}
                title={r}
              >
                <span className="aspect-box"><AspectShape ratio={r} /></span>
                <span className="aspect-label">{r}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
