import { type ReactNode, useEffect, useState } from "react";
import { api, ASPECT_RATIOS, MAX_TASK_ATTEMPTS, MODELS, OUTPUT_FORMATS, RESOLUTIONS, Tag } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/Button";
import Popover from "./ui/Popover";
import Segmented from "./ui/Segmented";
import TagPicker from "./TagPicker";

// A compact "pill" trigger that opens a popover with the full control. The
// composer shows one row of these instead of stacked labeled sections.
function ParamPill({
  label,
  value,
  children,
  disabled,
  title,
  panelClassName = "toolbar-popover",
}: {
  label: string;
  value: ReactNode;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  title?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      fixed
      align="start"
      className="param-pill-wrap"
      panelClassName={panelClassName}
      panelProps={{ role: "dialog", "aria-label": label }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button
          type="button"
          className={`param-pill${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={label}
          title={title ?? label}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {value}
          <Icon name="chevronDown" size="sm" className="param-pill-chevron" />
        </button>
      }
    >
      {children(() => setOpen(false))}
    </Popover>
  );
}

function AspectShape({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(":").map(Number);
  return <span className="aspect-shape" style={{ aspectRatio: `${w} / ${h}` }} />;
}

export function ComposerParams({
  model,
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
  model: string;
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
  const current = MODELS.find((m) => m.id === model);
  const isPro = current?.pro ?? false;
  const [tags, setTags] = useState<Tag[]>([]);

  // Names for the archive pill summary; refreshed whenever the selection changes
  // so a tag created inside the picker shows up immediately.
  useEffect(() => {
    api.listTags().then((r) => setTags(r.tags)).catch(() => {});
  }, [tagIds]);
  const selectedNames = tags.filter((tag) => tagIds.includes(tag.id)).map((tag) => tag.name);

  return (
    <div className="composer-params">
      <ParamPill label={t("model")} value={<span className="param-pill-text">{current?.label ?? model}</span>}>
        {(close) => (
          <div className="pill-options" role="listbox">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === model}
                className="custom-select-item"
                onClick={() => {
                  setModel(m.id);
                  close();
                }}
              >
                <span className="check">{m.id === model && <Icon name="check" size="sm" />}</span>
                {m.label}
              </button>
            ))}
          </div>
        )}
      </ParamPill>

      <ParamPill
        label={t("aspect")}
        value={
          <>
            <AspectShape ratio={aspectRatio} />
            {aspectRatio}
          </>
        }
      >
        {(close) => (
          <div className="aspect-grid">
            {ASPECT_RATIOS.map((r) => (
              <button
                key={r}
                type="button"
                className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
                aria-pressed={aspectRatio === r}
                onClick={() => {
                  setAspectRatio(r);
                  close();
                }}
              >
                <AspectShape ratio={r} />
                <span className="aspect-label">{r}</span>
              </button>
            ))}
          </div>
        )}
      </ParamPill>

      <ParamPill
        label={t("resolution")}
        title={isPro ? t("resolution") : `${t("resolution")}${t("pro_only")}`}
        disabled={!isPro}
        value={isPro ? resolution : "—"}
      >
        {(close) => (
          <Segmented
            value={resolution}
            onChange={(r) => {
              setResolution(r);
              close();
            }}
            options={RESOLUTIONS.map((r) => ({ value: r, label: r }))}
          />
        )}
      </ParamPill>

      <ParamPill
        label={t("format")}
        value={OUTPUT_FORMATS.find((f) => f.id === format)?.label ?? format}
      >
        {(close) => (
          <Segmented
            value={format}
            onChange={(f) => {
              setFormat(f);
              close();
            }}
            options={OUTPUT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
          />
        )}
      </ParamPill>

      <ParamPill
        label={t("archive_to")}
        panelClassName="toolbar-popover tag-popover"
        value={
          <>
            <Icon name="tag" size="sm" />
            <span className="param-pill-text">
              {selectedNames.length === 0
                ? t("archive_short")
                : selectedNames.length === 1
                ? selectedNames[0]
                : t("archive_n", { n: selectedNames.length })}
            </span>
          </>
        }
      >
        {() => (
          <>
            <span className="toolbar-popover-label">{t("archive_to")}</span>
            <TagPicker selected={tagIds} onChange={setTagIds} />
          </>
        )}
      </ParamPill>
    </div>
  );
}

// Primary "Generate" plus a retry-group dropdown: try up to N times, and
// whether this task itself skips once a preceding task in its group succeeds.
export function GenerateSplitButton({
  onGenerate,
  disabled,
  attempts,
  setAttempts,
  skip,
  setSkip,
}: {
  onGenerate: () => void;
  disabled: boolean;
  attempts: number;
  setAttempts: (fn: (n: number) => number) => void;
  skip: boolean;
  setSkip: (fn: (v: boolean) => boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="split-btn">
      <button
        type="button"
        className="primary split-btn-main"
        onClick={onGenerate}
        disabled={disabled}
        title={t("submit_shortcut_hint")}
      >
        {t("generate")}
        <kbd className="kbd">⌘↵</kbd>
      </button>
      <Popover
        fixed
        className="split-btn-more-wrap"
        panelClassName="toolbar-popover"
        panelProps={{ role: "dialog", "aria-label": t("retry_settings") }}
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            className="split-btn-more"
            aria-label={t("retry_settings")}
            title={t("retry_settings")}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {(attempts > 1 || skip) && (
              <span className="split-btn-badge">
                {attempts > 1 ? `×${attempts}` : t("skip_short")}
              </span>
            )}
            <Icon name="chevronDown" size="sm" />
          </button>
        }
      >
        <div className="toolbar-popover-section">
          <span className="toolbar-popover-label">{t("attempts")}</span>
          <div className="attempts-field">
            <IconButton
              variant="outline"
              icon="remove"
              label={t("attempts_decrease")}
              onClick={() => setAttempts((n) => Math.max(1, n - 1))}
              disabled={attempts <= 1}
            />
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
            <IconButton
              variant="outline"
              icon="add"
              label={t("attempts_increase")}
              onClick={() => setAttempts((n) => Math.min(MAX_TASK_ATTEMPTS, n + 1))}
              disabled={attempts >= MAX_TASK_ATTEMPTS}
            />
          </div>
          <span className="muted small popover-hint">{t("attempts_hint")}</span>
        </div>
        <div className="toolbar-popover-section">
          <button
            type="button"
            className={`skip-toggle${skip ? " on" : ""}`}
            aria-pressed={skip}
            onClick={() => setSkip((v) => !v)}
          >
            {t("skip_if_preceding_succeeds")}
          </button>
          <span className="muted small popover-hint">{t("skip_if_preceding_succeeds_title")}</span>
        </div>
      </Popover>
    </div>
  );
}
