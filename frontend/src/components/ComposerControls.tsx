import { MAX_TASK_ATTEMPTS, OUTPUT_FORMATS, ProviderId } from "../api";
import { useProviders } from "../useProviders";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import Segmented from "./ui/Segmented";
import TagPicker from "./TagPicker";
import ModelMenu from "./ModelMenu";

// Outline of the ratio, its long side fitted to `size` px.
export function AspectShape({ ratio, size = 22 }: { ratio: string; size?: number }) {
  const [w, h] = ratio.split(":").map(Number);
  const width = w >= h ? size : Math.round((size * w) / h);
  const height = h >= w ? size : Math.round((size * h) / w);
  return <span className="aspect-shape" style={{ width, height }} />;
}

// Every generation parameter laid out flat — one click each, no popovers:
// a label column on the left, one row per group.
export function ComposerParams({
  provider,
  model,
  setProvider,
  setModel,
  aspectRatio,
  setAspectRatio,
  resolution,
  setResolution,
  format,
  setFormat,
  tagIds,
  setTagIds,
}: {
  provider: ProviderId;
  model: string;
  setProvider: (provider: ProviderId) => void;
  setModel: (v: string) => void;
  aspectRatio: string;
  setAspectRatio: (v: string) => void;
  resolution: string;
  setResolution: (v: string) => void;
  format: string;
  setFormat: (v: string) => void;
  tagIds: number[];
  setTagIds: (ids: number[]) => void;
}) {
  const { t } = useI18n();
  const { spec: specOf, providers } = useProviders();
  const spec = specOf(provider, model);
  const hasResolution = (spec?.resolutions.length ?? 0) > 0;
  // A model without resolutions still shows the choices (disabled), as before.
  const resolutions = hasResolution
    ? spec!.resolutions
    : [...new Set(providers.flatMap((p) => p.models.flatMap((m) => m.resolutions)))];
  const formats = OUTPUT_FORMATS.filter((f) => spec?.outputFormats.includes(f.id) ?? true);

  return (
    <div className="composer-params">
      <span className="param-label param-label-model">{t("model")}</span>
      <div className="param-model">
        <ModelMenu
          provider={provider}
          model={model}
          onChange={(choice) => {
            setProvider(choice.provider);
            setModel(choice.model);
          }}
        />
      </div>

      {/* Resolution + format ride along on the model row while there is room.
          A narrow card drops them onto their own labelled row instead of
          letting them wrap unevenly next to the model picker. */}
      <span className="param-label param-label-output">{t("output")}</span>
      <div className="param-output">
        <Segmented
          value={resolution}
          onChange={setResolution}
          disabled={!hasResolution}
          title={hasResolution ? t("resolution") : `${t("resolution")}${t("pro_only")}`}
          options={resolutions.map((r) => ({ value: r, label: r }))}
        />
        <Segmented
          value={format}
          onChange={setFormat}
          title={t("format_short")}
          options={formats.map((f) => ({ value: f.id, label: f.label }))}
        />
        {spec?.transcodes.includes(format) && (
          <span className="model-transcode" title={t("jpg_transcode_hint")}>
            <Icon name="info" size="sm" />
            {t("jpg_converted_locally")}
          </span>
        )}
      </div>

      <span className="param-label">{t("aspect_short")}</span>
      <div className="aspect-row" role="group" aria-label={t("aspect")}>
        {(spec?.aspectRatios ?? []).map((r) => (
          <button
            key={r}
            type="button"
            className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
            aria-pressed={aspectRatio === r}
            onClick={() => setAspectRatio(r)}
          >
            <span className="aspect-box"><AspectShape ratio={r} /></span>
            <span className="aspect-label">{r}</span>
          </button>
        ))}
      </div>

      <span className="param-label" title={t("archive_to")}>{t("archive_short")}</span>
      <TagPicker selected={tagIds} onChange={setTagIds} />
    </div>
  );
}

// "Up to N tries": one submit enqueues N copies as a retry group.
export function AttemptsStepper({
  attempts,
  setAttempts,
}: {
  attempts: number;
  setAttempts: (fn: (n: number) => number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="attempts-field" role="group" aria-label={t("attempts")} title={t("attempts_hint")}>
      <span>{t("attempts_prefix")}</span>
      <div className="stepper">
        <button
          type="button"
          aria-label={t("attempts_decrease")}
          onClick={() => setAttempts((n) => Math.max(1, n - 1))}
          disabled={attempts <= 1}
        >
          <Icon name="remove" size="sm" />
        </button>
        <input
          type="number"
          min={1}
          max={MAX_TASK_ATTEMPTS}
          value={attempts}
          aria-label={t("attempts")}
          onChange={(e) => {
            const v = Math.floor(Number(e.target.value));
            if (!Number.isFinite(v)) return;
            setAttempts(() => Math.max(1, Math.min(MAX_TASK_ATTEMPTS, v || 1)));
          }}
        />
        <button
          type="button"
          aria-label={t("attempts_increase")}
          onClick={() => setAttempts((n) => Math.min(MAX_TASK_ATTEMPTS, n + 1))}
          disabled={attempts >= MAX_TASK_ATTEMPTS}
        >
          <Icon name="add" size="sm" />
        </button>
      </div>
      <span>{t("attempts_suffix")}</span>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? " on" : ""}`}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track"><span className="switch-knob" /></span>
      {label}
    </button>
  );
}
