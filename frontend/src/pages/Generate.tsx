import { useCallback, useEffect, useState } from "react";
import { Prefill } from "../App";
import {
  ImageRow,
  MAX_TASK_ATTEMPTS,
  MODELS,
  normalizeModelId,
  QueueTask,
  TaskSpec,
} from "../api";
import { useI18n } from "../i18n";
import ReferenceTray from "../components/ReferenceTray";
import OptionBar from "../components/OptionBar";
import QueueList from "../components/QueueList";
import TagPicker from "../components/TagPicker";

const ATTEMPTS_KEY = "imagen-task-attempts";

export default function Generate({
  tray,
  prefill,
  consumePrefill,
  addManyToTray,
  removeFromTray,
  moveInTray,
  keyConfigured,
  queue,
  enqueue,
  onSaveDraft,
  removeTask,
  abortTask,
  clearDone,
  onReuseTask,
  onReuseGenerateTask,
  onSaveQueueTaskAsDraft,
  onSetTaskMarker,
  onOpenViewer,
  concurrency,
  setConcurrency,
  maxConcurrency,
}: {
  tray: ImageRow[];
  prefill: Prefill | null;
  consumePrefill: () => void;
  addManyToTray: (imgs: ImageRow[]) => void;
  removeFromTray: (id: number) => void;
  moveInTray: (from: number, to: number) => void;
  keyConfigured: boolean;
  queue: QueueTask[];
  enqueue: (task: TaskSpec, count?: number) => void;
  onSaveDraft: (task: TaskSpec) => Promise<boolean>;
  removeTask: (id: string) => void;
  abortTask: (id: string) => void;
  clearDone: () => void;
  onReuseTask: (task: QueueTask) => void;
  onReuseGenerateTask: (task: QueueTask) => void;
  onSaveQueueTaskAsDraft: (task: QueueTask, move: boolean) => void;
  onSetTaskMarker: (id: string, color: import("../api").MarkerColor | null) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  concurrency: number;
  setConcurrency: (n: number) => void;
  maxConcurrency: number;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [resolution, setResolution] = useState("1K");
  const [format, setFormat] = useState("image/jpeg");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [skipIfPrecedingSucceeds, setSkipIfPrecedingSucceeds] = useState(false);
  // "Try up to N times": one submit enqueues N copies of the task as a retry
  // group (copies 2..N are auto-skip, so the first success cancels the rest).
  const [attempts, setAttempts] = useState(() => {
    const raw = Number(localStorage.getItem(ATTEMPTS_KEY));
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX_TASK_ATTEMPTS
      ? raw
      : 1;
  });

  useEffect(() => {
    localStorage.setItem(ATTEMPTS_KEY, String(attempts));
  }, [attempts]);

  // Apply a "reuse" prefill coming from the History tab.
  useEffect(() => {
    if (prefill) {
      setPrompt(prefill.prompt);
      setModel(normalizeModelId(prefill.model));
      if (prefill.aspectRatio) setAspectRatio(prefill.aspectRatio);
      if (prefill.resolution) setResolution(prefill.resolution);
      consumePrefill();
    }
  }, [prefill, consumePrefill]);

  const isPro = MODELS.find((m) => m.id === model)?.pro ?? false;
  const canSubmit = keyConfigured && (!!prompt.trim() || tray.length > 0);

  const currentTask = (): TaskSpec => ({
    prompt,
    model,
    aspectRatio,
    resolution: isPro ? resolution : null,
    format,
    inputs: [...tray],
    outputImages: [],
    tagIds: [...tagIds],
    skipIfPrecedingSucceeds,
  });

  // Submit: snapshot the composer into the queue. Keep the prompt in place so
  // repeated generations and small edits don't require retyping it.
  const submit = () => {
    enqueue(currentTask(), attempts);
  };

  const useAsRef = useCallback(
    (img: ImageRow) => addManyToTray([img]),
    [addManyToTray],
  );

  return (
    <div>
      <div className="panel">
        <ReferenceTray
          tray={tray}
          onAdd={addManyToTray}
          onRemove={removeFromTray}
          onMove={moveInTray}
        />
        <div style={{ marginTop: 16 }}>
          <label>{t("prompt")}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter enqueues, same as the generate button.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("prompt_placeholder")}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <OptionBar
            model={model}
            setModel={setModel}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            resolution={resolution}
            setResolution={setResolution}
            format={format}
            setFormat={setFormat}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <label>{t("archive_to")}</label>
          <TagPicker selected={tagIds} onChange={setTagIds} />
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
          <button
            className="primary"
            onClick={submit}
            disabled={!canSubmit}
            title={t("submit_shortcut_hint")}
          >
            {t("generate")}
          </button>
          <button onClick={() => onSaveDraft(currentTask())} title={t("save_draft_hint")}>
            <i className="fa-solid fa-box-archive" /> {t("save_draft")}
          </button>
          <span className="muted small">
            {t("ref_count", { n: tray.length })}
            {!keyConfigured && t("need_key_inline")}
          </span>
          <button
            className={`skip-toggle${skipIfPrecedingSucceeds ? " on" : ""}`}
            onClick={() => setSkipIfPrecedingSucceeds((v) => !v)}
            title={t("skip_if_preceding_succeeds_title")}
          >
            {t("skip_if_preceding_succeeds")}
          </button>
          <div className="attempts-field" title={t("attempts_hint")}>
            <span className="muted small">{t("attempts")}</span>
            <button
              onClick={() => setAttempts((n) => Math.max(1, n - 1))}
              disabled={attempts <= 1}
            >
              −
            </button>
            <input
              type="number"
              min={1}
              max={MAX_TASK_ATTEMPTS}
              value={attempts}
              onChange={(e) => {
                const v = Math.floor(Number(e.target.value));
                if (!Number.isFinite(v)) return;
                setAttempts(Math.max(1, Math.min(MAX_TASK_ATTEMPTS, v || 1)));
              }}
            />
            <button
              onClick={() =>
                setAttempts((n) => Math.min(MAX_TASK_ATTEMPTS, n + 1))
              }
              disabled={attempts >= MAX_TASK_ATTEMPTS}
            >
              +
            </button>
          </div>
          <div className="spacer" />
        </div>
      </div>

      <QueueList
        queue={queue}
        onRemove={removeTask}
        onAbort={abortTask}
        onClearDone={clearDone}
        onUseAsRef={useAsRef}
        onReuse={onReuseTask}
        onReuseGenerate={onReuseGenerateTask}
        onSaveDraft={onSaveQueueTaskAsDraft}
        onSetMarker={onSetTaskMarker}
        onOpenViewer={onOpenViewer}
        concurrency={concurrency}
        setConcurrency={setConcurrency}
        maxConcurrency={maxConcurrency}
      />
    </div>
  );
}
