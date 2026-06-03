import { type CSSProperties, useEffect, useState } from "react";
import { ImageRow, QueueTask, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

const QUEUE_COLUMNS_KEY = "imagen-queue-columns";
const QUEUE_COLUMN_OPTIONS = [1, 2, 3];
const PROMPT_PREVIEW_CHARS = 240;
const PROMPT_PREVIEW_LINES = 4;

function initialQueueColumns() {
  const saved = Number(localStorage.getItem(QUEUE_COLUMNS_KEY));
  return QUEUE_COLUMN_OPTIONS.includes(saved) ? saved : 1;
}

export default function QueueList({
  queue,
  onRemove,
  onClearDone,
  onUseAsRef,
}: {
  queue: QueueTask[];
  onRemove: (id: string) => void;
  onClearDone: () => void;
  onUseAsRef: (img: ImageRow) => void;
}) {
  const { t } = useI18n();
  const [columns, setColumns] = useState(initialQueueColumns);

  useEffect(() => {
    localStorage.setItem(QUEUE_COLUMNS_KEY, String(columns));
  }, [columns]);

  if (queue.length === 0) return null;

  const hasDone = queue.some((task) => task.status !== "pending" && task.status !== "running");
  // Newest first.
  const ordered = [...queue].reverse();

  return (
    <div className="queue">
      <div className="queue-head">
        <h3 style={{ margin: 0 }}>{t("queue_title")}</h3>
        <span className="muted small">{queue.length}</span>
        <div className="spacer" style={{ flex: 1 }} />
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
            onUseAsRef={onUseAsRef}
          />
        ))}
      </div>
    </div>
  );
}

function QueueItem({
  task,
  onRemove,
  onUseAsRef,
}: {
  task: QueueTask;
  onRemove: (id: string) => void;
  onUseAsRef: (img: ImageRow) => void;
}) {
  const { t, reason } = useI18n();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [w, h] = task.aspectRatio.split(":").map(Number);
  const promptNeedsToggle =
    task.prompt.length > PROMPT_PREVIEW_CHARS ||
    task.prompt.split(/\r?\n/).length > PROMPT_PREVIEW_LINES;

  return (
    <div className="qcard">
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
          {task.status !== "running" && (
            <button className="q-x" title={t("remove_task")} onClick={() => onRemove(task.id)}>
              ×
            </button>
          )}
        </div>

        {task.prompt && (
          <div className="q-prompt-wrap">
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
        {(task.status === "pending" || task.status === "running") && (
          <div
            className={`q-shimmer${task.status === "running" ? " active" : ""}`}
            style={{ aspectRatio: `${w} / ${h}` }}
          />
        )}

        {task.status === "success" && task.outputImage && (
          <div className="q-result">
            <a href={imgFileUrl(task.outputImage.id)} target="_blank" rel="noreferrer">
              <img src={imgFileUrl(task.outputImage.id)} alt="result" />
            </a>
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
      </div>
    </div>
  );
}
