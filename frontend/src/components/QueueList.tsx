import { type CSSProperties, memo, useEffect, useState } from "react";
import { ImageRow, MARKER_COLORS, MarkerColor, QueueTask, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const QUEUE_COLUMNS_KEY = "imagen-queue-columns";
const QUEUE_COLUMN_OPTIONS = [1, 2, 3];
const PROMPT_PREVIEW_CHARS = 240;
const PROMPT_PREVIEW_LINES = 4;
const MARKER_COLOR_KEY = "imagen-marker-color";

function initialMarkerColor(): MarkerColor {
  const saved = localStorage.getItem(MARKER_COLOR_KEY);
  return MARKER_COLORS.some((color) => color.id === saved) ? saved as MarkerColor : "red";
}

const markerHex = (color: MarkerColor | null | undefined) =>
  MARKER_COLORS.find((item) => item.id === color)?.hex ?? MARKER_COLORS[0].hex;

function initialQueueColumns() {
  const saved = Number(localStorage.getItem(QUEUE_COLUMNS_KEY));
  return QUEUE_COLUMN_OPTIONS.includes(saved) ? saved : 1;
}

export default function QueueList({
  queue,
  onRemove,
  onAbort,
  onClearDone,
  onUseAsRef,
  onReuse,
  onReuseGenerate,
  onSaveDraft,
  onSetMarker,
  onOpenViewer,
  concurrency,
  setConcurrency,
  maxConcurrency,
}: {
  queue: QueueTask[];
  onRemove: (id: string) => void;
  onAbort: (id: string) => void;
  onClearDone: () => void;
  onUseAsRef: (img: ImageRow) => void;
  onReuse: (task: QueueTask) => void;
  onReuseGenerate: (task: QueueTask) => void;
  onSaveDraft: (task: QueueTask, move: boolean) => void;
  onSetMarker: (id: string, color: MarkerColor | null) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  concurrency: number;
  setConcurrency: (n: number) => void;
  maxConcurrency: number;
}) {
  const { t } = useI18n();
  const [columns, setColumns] = useState(initialQueueColumns);
  const [defaultMarkerColor, setDefaultMarkerColor] = useState(initialMarkerColor);

  useEffect(() => {
    localStorage.setItem(QUEUE_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(MARKER_COLOR_KEY, defaultMarkerColor);
  }, [defaultMarkerColor]);

  if (queue.length === 0) return null;

  const isActive = (s: QueueTask["status"]) =>
    s === "pending" || s === "running" || s === "cancelling";
  const hasDone = queue.some((task) => !isActive(task.status));
  // Newest first.
  const ordered = [...queue].reverse();

  return (
    <div className="queue">
      <div className="queue-head">
        <h3 style={{ margin: 0 }}>{t("queue_title")}</h3>
        <span className="muted small">{queue.length}</span>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="muted small queue-density-label">{t("concurrency")}</span>
        <div className="seg density-seg queue-density" title={t("concurrency_hint")}>
          {Array.from({ length: maxConcurrency }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className={concurrency === n ? "on" : ""}
              onClick={() => setConcurrency(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="muted small queue-density-label">{t("columns_per_row")}</span>
        <div className="seg density-seg queue-density">
          {QUEUE_COLUMN_OPTIONS.map((n) => (
            <button
              key={n}
              className={columns === n ? "on" : ""}
              onClick={() => setColumns(n)}
            >
              {n}
            </button>
          ))}
        </div>
        {hasDone && (
          <button onClick={() => onClearDone()}>{t("clear_done")}</button>
        )}
      </div>

      <div
        className="queue-grid"
        style={{ "--queue-columns": columns } as CSSProperties}
      >
        {ordered.map((task) => (
          <QueueItem
            key={task.id}
            task={task}
            onRemove={onRemove}
            onAbort={onAbort}
            onUseAsRef={onUseAsRef}
            onReuse={onReuse}
            onReuseGenerate={onReuseGenerate}
            onSaveDraft={onSaveDraft}
            onSetMarker={onSetMarker}
            defaultMarkerColor={defaultMarkerColor}
            onDefaultMarkerColor={setDefaultMarkerColor}
            onOpenViewer={onOpenViewer}
          />
        ))}
      </div>
    </div>
  );
}

// Memoized: only the card whose task object changed re-renders. The undo-send
// countdown ticks locally here so it never re-renders App or the other cards.
const QueueItem = memo(function QueueItem({
  task,
  onRemove,
  onAbort,
  onUseAsRef,
  onReuse,
  onReuseGenerate,
  onSaveDraft,
  onSetMarker,
  defaultMarkerColor,
  onDefaultMarkerColor,
  onOpenViewer,
}: {
  task: QueueTask;
  onRemove: (id: string) => void;
  onAbort: (id: string) => void;
  onUseAsRef: (img: ImageRow) => void;
  onReuse: (task: QueueTask) => void;
  onReuseGenerate: (task: QueueTask) => void;
  onSaveDraft: (task: QueueTask, move: boolean) => void;
  onSetMarker: (id: string, color: MarkerColor | null) => void;
  defaultMarkerColor: MarkerColor;
  onDefaultMarkerColor: (color: MarkerColor) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
}) {
  const { t, reason } = useI18n();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [markerPickerOpen, setMarkerPickerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const counting = task.status === "pending" && task.dispatchAt > now;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [counting]);
  const [w, h] = task.aspectRatio.split(":").map(Number);
  const promptNeedsToggle =
    task.prompt.length > PROMPT_PREVIEW_CHARS ||
    task.prompt.split(/\r?\n/).length > PROMPT_PREVIEW_LINES;
  // Seconds left in the undo-send window (0 once it has been/should be sent).
  const undoLeft =
    task.status === "pending"
      ? Math.max(0, Math.ceil((task.dispatchAt - now) / 1000))
      : 0;

  // Fine-grained live status line (delaying / queued / sent / retrying).
  let substatus: string | null = null;
  if (task.status === "pending") {
    substatus = undoLeft > 0 ? t("phase_delaying") : t("phase_queued");
  } else if (task.status === "running") {
    if (task.phase?.phase === "retrying") {
      substatus = t("phase_retrying", {
        code: task.phase.code ?? "?",
        n: task.phase.delay ?? 0,
      });
    } else if (task.phase?.phase === "sent") {
      substatus = t("phase_sent", { n: task.phase.attempt ?? 1 });
    } else {
      substatus = t("phase_running");
    }
  } else if (task.status === "cancelling") {
    substatus = t("phase_cancelling");
  }

  return (
    <div
      className={`qcard${task.markerColor ? " marked" : ""}`}
      style={{ "--marker-color": markerHex(task.markerColor) } as CSSProperties}
    >
      <div className="q-inputs">
        {task.inputs.map((im) => (
          <img key={im.id} className="q-thumb" src={imgThumbUrl(im.id)} alt={im.filename} />
        ))}
        {task.inputs.length === 0 && <span className="muted small">{t("no_refs")}</span>}
      </div>

      <div className="q-body">
        <div className="q-meta">
          <span className={`badge ${task.status}`}>{t(`status_${task.status}`)}</span>
          <span className="muted small">{task.model.replace("-image", "").replace("-preview", "")}</span>
          <span className="muted small">· {task.aspectRatio}</span>
          {task.resolution && <span className="muted small">· {task.resolution}</span>}
          <div className="spacer" style={{ flex: 1 }} />
          <div className="marker-control">
            <button
              className={`q-icon-btn marker-toggle${task.markerColor ? " marked" : ""}`}
              style={{ "--marker-color": markerHex(task.markerColor ?? defaultMarkerColor) } as CSSProperties}
              title={task.markerColor ? t("remove_marker") : t("add_marker")}
              onClick={() => onSetMarker(task.id, task.markerColor ? null : defaultMarkerColor)}
            >
              <i className="fa-solid fa-bookmark" />
            </button>
            <button
              className="q-icon-btn marker-picker-toggle"
              title={t("choose_marker_color")}
              onClick={() => setMarkerPickerOpen((value) => !value)}
            >
              <i className="fa-solid fa-caret-down" />
            </button>
            {markerPickerOpen && (
              <div className="marker-picker" role="group" aria-label={t("choose_marker_color")}>
                {MARKER_COLORS.map((color) => (
                  <button
                    key={color.id}
                    className={defaultMarkerColor === color.id ? "selected" : ""}
                    style={{ "--marker-color": color.hex } as CSSProperties}
                    title={t(`marker_${color.id}`)}
                    onClick={() => {
                      onDefaultMarkerColor(color.id);
                      onSetMarker(task.id, color.id);
                      setMarkerPickerOpen(false);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            className="q-icon-btn q-reuse"
            title={t("reuse")}
            onClick={() => onReuse(task)}
          >
            <i className="fa-solid fa-pen" />
          </button>
          <button
            className="q-icon-btn q-reuse-generate"
            title={t("reuse_generate")}
            onClick={() => onReuseGenerate(task)}
          >
            <i className="fa-solid fa-bolt" />
          </button>
          <button
            className="q-icon-btn"
            title={t("save_copy_to_drafts")}
            onClick={() => onSaveDraft(task, false)}
          >
            <i className="fa-solid fa-box-archive" />
          </button>
          {task.status === "pending" && (
            <button
              className="q-icon-btn"
              title={t("move_to_drafts")}
              onClick={() => onSaveDraft(task, true)}
            >
              <i className="fa-solid fa-box-open" />
            </button>
          )}
          {undoLeft > 0 && (
            <button
              className="q-undo"
              title={t("undo_send_hint")}
              onClick={() => onRemove(task.id)}
            >
              {t("undo_send", { n: undoLeft })}
            </button>
          )}
          {task.status === "running" && (
            <button
              className="q-cancel"
              title={t("cancel_running_hint")}
              onClick={() => onAbort(task.id)}
            >
              {t("cancel_running")}
            </button>
          )}
          {task.status !== "running" &&
            task.status !== "cancelling" &&
            undoLeft === 0 && (
              <button className="q-icon-btn q-x" title={t("remove_task")} onClick={() => onRemove(task.id)}>
                ×
              </button>
            )}
        </div>

        {substatus && <div className="q-substatus">{substatus}</div>}

        {task.prompt && (
          <div className="q-prompt-wrap">
            {promptExpanded && promptNeedsToggle && (
              <button
                className="link-btn q-prompt-toggle q-prompt-toggle-top"
                onClick={() => setPromptExpanded(false)}
              >
                {t("show_less")}
              </button>
            )}
            <p className={`q-prompt${promptExpanded ? " expanded" : ""}`}>
              {task.prompt}
            </p>
            {promptNeedsToggle && (
              <button
                className="link-btn q-prompt-toggle"
                onClick={() => setPromptExpanded((v) => !v)}
              >
                {promptExpanded ? t("show_less") : t("show_more")}
              </button>
            )}
          </div>
        )}

        {/* Result area */}
        {(task.status === "pending" ||
          task.status === "running" ||
          task.status === "cancelling") && (
          <div
            className={`q-shimmer${
              task.status === "running" || task.status === "cancelling" ? " active" : ""
            }`}
            style={{ aspectRatio: `${w} / ${h}` }}
          />
        )}

        {task.status === "success" && task.outputImage && (
          <div className="q-result">
            <img
              src={imgThumbUrl(task.outputImage.id)}
              alt="result"
              className="q-result-img"
              title={t("open_viewer")}
              onClick={() => onOpenViewer(task.outputImage!, [])}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={() => onUseAsRef(task.outputImage!)}>{t("use_as_ref")}</button>
              <a href={imgFileUrl(task.outputImage.id)} download>
                <button style={{ width: "100%" }}>{t("download")}</button>
              </a>
            </div>
          </div>
        )}

        {(task.status === "blocked" || task.status === "error") && (
          <div className={`notice ${task.status === "blocked" ? "blocked" : "error"}`}>
            {reason(task.rawFinish) ||
              task.message ||
              (task.status === "blocked" ? t("blocked_fallback") : t("error_fallback"))}
          </div>
        )}

        {task.status === "aborted" && (
          <div className="notice aborted">{task.message || t("aborted_fallback")}</div>
        )}
      </div>
    </div>
  );
});
