import { useCallback, useEffect, useRef, useState } from "react";
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
import QueueList from "../components/QueueList";
import LibraryPickerModal from "../components/LibraryPickerModal";
import { AttemptsStepper, ComposerParams, Switch } from "../components/ComposerControls";
import { Button } from "../components/ui/Button";
import { useRemote } from "../remote";

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
  phone = false,
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
  phone?: boolean;
}) {
  const { t } = useI18n();
  const { conn } = useRemote();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [resolution, setResolution] = useState("1K");
  const [format, setFormat] = useState("image/jpeg");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [skipIfPrecedingSucceeds, setSkipIfPrecedingSucceeds] = useState(false);
  const [pickingRefs, setPickingRefs] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
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
    <div className={phone ? "composer-phone" : undefined}>
      <div className="panel composer" ref={composerRef}>
        <div className="composer-input">
          <ReferenceTray
            compact
            dropTarget={composerRef}
            tray={tray}
            onAdd={addManyToTray}
            onRemove={removeFromTray}
            onMove={moveInTray}
            onPickLibrary={() => setPickingRefs(true)}
            onOpen={(img) => onOpenViewer(img, tray)}
          />
          <textarea
            className="composer-prompt"
            aria-label={t("prompt")}
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
        <ComposerParams
          model={model}
          setModel={setModel}
          aspectRatio={aspectRatio}
          setAspectRatio={setAspectRatio}
          resolution={resolution}
          setResolution={setResolution}
          format={format}
          setFormat={setFormat}
          tagIds={tagIds}
          setTagIds={setTagIds}
        />
        <div className="composer-foot">
          <AttemptsStepper attempts={attempts} setAttempts={setAttempts} />
          <Switch
            checked={skipIfPrecedingSucceeds}
            onChange={setSkipIfPrecedingSucceeds}
            label={t("skip_switch")}
            title={t("skip_if_preceding_succeeds_title")}
          />
          <div className="spacer" />
          {!keyConfigured && <span className="muted small">{t("need_key_inline").replace(/^ · /, "")}</span>}
          <Button icon="saveDraft" onClick={() => onSaveDraft(currentTask())} title={t("save_draft_hint")}>
            {t("save_draft")}
          </Button>
          <button
            type="button"
            className="primary composer-generate"
            onClick={submit}
            disabled={!canSubmit}
            title={t("submit_shortcut_hint")}
          >
            {conn === "lost" ? t("remote_waiting") : attempts > 1 ? t("generate_n", { n: attempts }) : t("generate")}
            {conn !== "lost" && <kbd className="kbd">⌘↵</kbd>}
          </button>
        </div>
      </div>

      {pickingRefs && (
        <LibraryPickerModal
          mode="multi"
          onPick={(img) => addManyToTray([img])}
          onClose={() => setPickingRefs(false)}
        />
      )}

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
