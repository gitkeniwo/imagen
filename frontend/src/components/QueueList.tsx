import { type CSSProperties, memo, useEffect, useState } from "react";
import { ImageRow, MARKER_COLORS, MarkerColor, QueueTask } from "../api";
import { useI18n } from "../i18n";
import { copyText } from "../clipboard";
import { Button } from "./ui/Button";
import Segmented from "./ui/Segmented";
import Popover from "./ui/Popover";
import Icon from "./ui/Icon";
import { PopoverSection, ViewPopover } from "./ui/ToolbarPopover";
import { useToast } from "./Toast";
import GenerationCard, { type CardAction, type CardMedia, MarkerSwatches, downloadImage } from "./GenerationCard";
import type { MenuItem } from "./ui/Menu";

// v2: the old key held the pre-card horizontal layout's 1-column default.
const QUEUE_COLUMNS_KEY = "imagen-queue-columns-v2";
// 0 = auto: as many ~260px cards as fit the width.
const QUEUE_COLUMN_OPTIONS = [0, 1, 2, 3, 4];
const MARKER_COLOR_KEY = "imagen-marker-color";

function initialMarkerColor(): MarkerColor {
  const saved = localStorage.getItem(MARKER_COLOR_KEY);
  return MARKER_COLORS.some((color) => color.id === saved) ? saved as MarkerColor : "red";
}

function initialQueueColumns() {
  const raw = localStorage.getItem(QUEUE_COLUMNS_KEY);
  const saved = Number(raw);
  return raw !== null && QUEUE_COLUMN_OPTIONS.includes(saved) ? saved : 0;
}

// "Parallel N" dropdown: the value plus what it means, instead of a bare 1–10 strip.
function ConcurrencyControl({
  value,
  onChange,
  max,
}: {
  value: number;
  onChange: (n: number) => void;
  max: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      fixed
      className="toolbar-popover-wrap"
      panelClassName="toolbar-popover"
      panelProps={{ role: "dialog", "aria-label": t("concurrency") }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <Button className="toolbar-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t("concurrency")} {value}
          <Icon name="chevronDown" size="sm" />
        </Button>
      }
    >
      <PopoverSection label={t("concurrency")}>
        <Segmented
          dense
          className="density-seg"
          value={value}
          onChange={onChange}
          options={Array.from({ length: max }, (_, i) => i + 1).map((n) => ({
            value: n,
            label: String(n),
          }))}
        />
        <span className="muted small popover-hint">{t("concurrency_hint")}</span>
      </PopoverSection>
    </Popover>
  );
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
        <h3 className="m-0">{t("queue_title")}</h3>
        <span className="muted small">{queue.length}</span>
        <div className="spacer" />
        <ConcurrencyControl value={concurrency} onChange={setConcurrency} max={maxConcurrency} />
        <ViewPopover>
          <PopoverSection label={t("columns_per_row")}>
            <Segmented
              dense
              className="density-seg"
              value={columns}
              onChange={setColumns}
              options={QUEUE_COLUMN_OPTIONS.map((n) => ({
                value: n,
                label: n === 0 ? t("columns_auto") : String(n),
              }))}
            />
          </PopoverSection>
        </ViewPopover>
        {hasDone && (
          <Button onClick={() => onClearDone()}>{t("clear_done")}</Button>
        )}
      </div>

      <div
        className={`queue-grid${columns === 0 ? " auto" : ""}`}
        style={columns ? ({ "--queue-columns": columns } as CSSProperties) : undefined}
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
  onDefaultMarkerColor: (color: MarkerColor) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
}) {
  const { t, reason } = useI18n();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  const counting = task.status === "pending" && task.dispatchAt > now;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [counting]);
  // Seconds left in the undo-send window (0 once it has been/should be sent).
  const undoLeft =
    task.status === "pending"
      ? Math.max(0, Math.ceil((task.dispatchAt - now) / 1000))
      : 0;
  const active = task.status === "pending" || task.status === "running" || task.status === "cancelling";

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

  const output = task.status === "success" ? task.outputImage ?? null : null;
  const media: CardMedia = output
    ? { kind: "image", image: output, onOpen: () => onOpenViewer(output, []) }
    : active
    ? { kind: "pending", active: task.status !== "pending" }
    : { kind: "empty" };

  const error =
    task.status === "blocked" || task.status === "error"
      ? {
          kind: task.status,
          message:
            reason(task.rawFinish) ||
            task.message ||
            (task.status === "blocked" ? t("blocked_fallback") : t("error_fallback")),
        }
      : task.status === "aborted"
      ? { kind: "aborted", message: task.message || t("aborted_fallback") }
      : null;

  const actions: CardAction[] = [
    { icon: "reuse", label: t("reuse"), onClick: () => onReuse(task) },
    { icon: "rerun", label: t("rerun_short"), onClick: () => onReuseGenerate(task) },
  ];
  if (output) actions.push({ icon: "addToRefs", label: t("as_ref_short"), onClick: () => onUseAsRef(output) });

  const menuItems: MenuItem[] = [
    { icon: "saveDraft", label: t("save_copy_to_drafts"), onSelect: () => onSaveDraft(task, false) },
  ];
  if (task.status === "pending") {
    menuItems.push({ icon: "moveToDrafts", label: t("move_to_drafts"), onSelect: () => onSaveDraft(task, true) });
  }
  if (output) {
    menuItems.push({
      icon: "download",
      label: t("download"),
      onSelect: () => downloadImage(output),
    });
  }
  if (task.prompt) {
    menuItems.push({
      icon: "copy",
      label: t("copy_prompt"),
      onSelect: async () => toast((await copyText(task.prompt)) ? t("copied") : t("copy_failed")),
    });
  }
  if (!active) {
    menuItems.push({ icon: "delete", label: t("remove_task"), danger: true, onSelect: () => onRemove(task.id) });
  }

  return (
    <GenerationCard
      media={media}
      aspectRatio={task.aspectRatio}
      status={task.status === "success" ? undefined : task.status}
      statusLabel={t(`status_${task.status}`)}
      markerColor={task.markerColor}
      meta={[task.model.replace("-image", "").replace("-preview", ""), task.aspectRatio, task.resolution]}
      substatus={substatus}
      error={error}
      prompt={task.prompt}
      inputs={task.inputs}
      onOpenInput={(im) => onOpenViewer(im, task.inputs)}
      actions={actions}
      extra={
        undoLeft > 0 ? (
          <button className="q-undo" title={t("undo_send_hint")} onClick={() => onRemove(task.id)}>
            {t("undo_send", { n: undoLeft })}
          </button>
        ) : task.status === "running" ? (
          <button className="q-cancel" title={t("cancel_running_hint")} onClick={() => onAbort(task.id)}>
            {t("cancel_running")}
          </button>
        ) : null
      }
      menuItems={menuItems}
      menuFooter={(close) => (
        <MarkerSwatches
          value={task.markerColor}
          onPick={(color) => {
            if (color) onDefaultMarkerColor(color);
            onSetMarker(task.id, color);
            close();
          }}
        />
      )}
    />
  );
});
