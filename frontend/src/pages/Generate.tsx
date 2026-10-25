import { useCallback, useEffect, useRef, useState } from "react";
import { Prefill } from "../App";
import {
  ImageRow,
  MAX_TASK_ATTEMPTS,
  MODELS,
  normalizeModelId,
  OUTPUT_FORMATS,
  QueueTask,
  TaskSpec,
} from "../api";
import { ComposerDraft } from "../composerDraft";
import { useI18n } from "../i18n";
import Popover from "../components/ui/Popover";
import ReferenceTray from "../components/ReferenceTray";
import QueueList from "../components/QueueList";
import LibraryPickerModal from "../components/LibraryPickerModal";
import { AttemptsStepper, ComposerParams, Switch } from "../components/ComposerControls";
import { Button, IconButton } from "../components/ui/Button";
import Icon from "../components/ui/Icon";
import Sheet from "../components/ui/Sheet";
import { RemoteChip } from "../components/RemoteIndicator";
import appIcon from "../assets/app-icon.png";
import { useRemote } from "../remote";

const ATTEMPTS_KEY = "imagen-task-attempts";

export default function Generate({
  tray,
  draft,
  updateDraft,
  clearComposer,
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
  draft: ComposerDraft;
  updateDraft: (patch: Partial<ComposerDraft>) => void;
  clearComposer: () => void;
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
  const [saveOpen, setSaveOpen] = useState(false);
  const { conn, remote } = useRemote();
  // The draft itself lives in App so one place owns loading/saving it.
  const {
    prompt,
    model,
    aspectRatio,
    resolution,
    format,
    tagIds,
    skipIfPrecedingSucceeds,
  } = draft;
  const setPrompt = (v: string) => updateDraft({ prompt: v });
  const setModel = (v: string) => updateDraft({ model: v });
  const setAspectRatio = (v: string) => updateDraft({ aspectRatio: v });
  const setResolution = (v: string) => updateDraft({ resolution: v });
  const setFormat = (v: string) => updateDraft({ format: v });
  const setTagIds = (ids: number[]) => updateDraft({ tagIds: ids });
  const setSkipIfPrecedingSucceeds = (v: boolean) =>
    updateDraft({ skipIfPrecedingSucceeds: v });
  const [pickingRefs, setPickingRefs] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
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

  // Apply a "reuse" prefill coming from the History tab (or the queue).
  useEffect(() => {
    if (prefill) {
      updateDraft({
        prompt: prefill.prompt,
        model: normalizeModelId(prefill.model),
        ...(prefill.aspectRatio ? { aspectRatio: prefill.aspectRatio } : {}),
        ...(prefill.resolution ? { resolution: prefill.resolution } : {}),
      });
      consumePrefill();
    }
  }, [prefill, consumePrefill, updateDraft]);

  const isPro = MODELS.find((m) => m.id === model)?.pro ?? false;
  const canSubmit = keyConfigured && (!!prompt.trim() || tray.length > 0);

  // Phone summary line: "Pro · 1K · JPG · 1:1" (resolution only for Pro).
  const modelShort = (MODELS.find((m) => m.id === model)?.label ?? model)
    .replace(/\s*\(.*\)$/, "");
  const formatLabel = OUTPUT_FORMATS.find((f) => f.id === format)?.label ?? format;
  const optionsSummary = [modelShort, isPro ? resolution : null, formatLabel, aspectRatio]
    .filter(Boolean)
    .join(" · ");

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
    <div className={phone ? "composer-phone phone-page" : undefined}>
      {phone && (
        <header className="phone-head">
          <img className="phone-logo" src={appIcon} alt="" />
          <h1>{t("tab_generate")}</h1>
          {remote && <RemoteChip />}
          <Popover
            fixed
            align="end"
            open={saveOpen}
            onClose={() => setSaveOpen(false)}
            panelClassName="confirm-bubble"
            panelProps={{ role: "dialog", "aria-label": t("save_draft") }}
            trigger={
              <IconButton
                icon="archive"
                label={t("save_draft")}
                aria-expanded={saveOpen}
                onClick={() => setSaveOpen((v) => !v)}
              />
            }
          >
            <p>{t("save_draft_confirm")}</p>
            <div className="confirm-bubble-actions">
              <Button size="sm" onClick={() => setSaveOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setSaveOpen(false);
                  onSaveDraft(currentTask());
                }}
              >
                {t("save_draft")}
              </Button>
            </div>
          </Popover>
        </header>
      )}
      <div className={phone ? "phone-body composer-phone-body" : "panel composer"} ref={composerRef}>
        <div className={phone ? "composer-phone-card" : "composer-input"}>
          <ReferenceTray
            compact
            phone={phone}
            dropTarget={composerRef}
            tray={tray}
            onAdd={addManyToTray}
            onRemove={removeFromTray}
            onMove={moveInTray}
            onPickLibrary={() => setPickingRefs(true)}
            onOpen={(img) => onOpenViewer(img, tray)}
          />
          <div className="composer-prompt-wrap">
            <textarea
              ref={promptRef}
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
            <div className="composer-clear-wrap">
              <Popover
                fixed
                align="end"
                open={clearOpen}
                onClose={() => setClearOpen(false)}
                panelClassName="confirm-bubble"
                panelProps={{ role: "dialog", "aria-label": t("composer_clear") }}
                trigger={
                  <IconButton
                    icon="clear"
                    label={t("composer_clear")}
                    aria-expanded={clearOpen}
                    disabled={!prompt.trim() && tray.length === 0}
                    onClick={() => setClearOpen((v) => !v)}
                  />
                }
              >
                <p>{t("composer_clear_confirm")}</p>
                <div className="confirm-bubble-actions">
                  <Button size="sm" onClick={() => setClearOpen(false)}>
                    {t("cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setClearOpen(false);
                      clearComposer();
                      // Let the popover unmount before moving focus back.
                      window.setTimeout(() => promptRef.current?.focus(), 0);
                    }}
                  >
                    {t("composer_clear")}
                  </Button>
                </div>
              </Popover>
            </div>
          </div>
          {phone && (
            <div className="composer-phone-optrow">
              <button
                type="button"
                className="composer-phone-optbtn"
                aria-haspopup="dialog"
                aria-expanded={optionsOpen}
                onClick={() => setOptionsOpen(true)}
              >
                <Icon name="editSettings" size="sm" />
                <span>{optionsSummary}</span>
                <Icon name="chevronDown" size="sm" />
              </button>
            </div>
          )}
        </div>
        {!phone && (
          <>
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
          </>
        )}

        {phone && (
          <QueueList
            phone
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
        )}
      </div>

      {phone && (
        <>
          <div className="phone-dock">
            {!keyConfigured && <div className="phone-dock-note">{t("no_key_warning")}</div>}
            <AttemptsStepper attempts={attempts} setAttempts={setAttempts} />
            <button
              type="button"
              className="primary composer-generate phone-generate"
              onClick={submit}
              disabled={!canSubmit}
              title={t("submit_shortcut_hint")}
            >
              <Icon name="generated" size="sm" />
              {conn === "lost" ? t("remote_waiting") : attempts > 1 ? t("generate_n", { n: attempts }) : t("generate")}
            </button>
          </div>
          {optionsOpen && (
            <Sheet
              title={t("phone_options")}
              onClose={() => setOptionsOpen(false)}
              footer={
                <Button
                  variant="primary"
                  className="phone-sheet-done"
                  onClick={() => setOptionsOpen(false)}
                >
                  {t("done")}
                </Button>
              }
            >
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
              <Switch
                checked={skipIfPrecedingSucceeds}
                onChange={setSkipIfPrecedingSucceeds}
                label={t("skip_switch")}
                title={t("skip_if_preceding_succeeds_title")}
              />
            </Sheet>
          )}
        </>
      )}

      {pickingRefs && (
        <LibraryPickerModal
          mode="multi"
          onPick={(img) => addManyToTray([img])}
          onClose={() => setPickingRefs(false)}
        />
      )}

      {!phone && (
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
      )}
    </div>
  );
}
