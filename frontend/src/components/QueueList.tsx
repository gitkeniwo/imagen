import { type CSSProperties, memo, useEffect, useState } from "react";
import { api, ImageRow, MARKER_COLORS, MarkerColor, QueueTask } from "../api";
import { useI18n } from "../i18n";
import { copyText } from "../clipboard";
import { Button } from "./ui/Button";
import Segmented from "./ui/Segmented";
import Popover from "./ui/Popover";
import Icon from "./ui/Icon";
import { PopoverSection, ViewPopover } from "./ui/ToolbarPopover";
import { useToast } from "./Toast";
import { MarkerSwatches, downloadImage, markerHex } from "./GenerationCard";
import { SeriesBadge } from "./SeriesBits";
import { useSeriesActions } from "./SeriesMenu";
import { useSeriesNav } from "../seriesContext";
import { FullTextButton, PromptClamp } from "./FullText";
import Menu from "./ui/Menu";
import { IconButton } from "./ui/Button";
import { type IconName } from "./ui/Icon";
import { imgThumbUrl } from "../api";
import { peekProps } from "./HoverPeek";
import { pressable } from "../a11y";
import ProviderBadge from "./ProviderBadge";
import { generationRuntime } from "../generationMetrics";
import { displayName } from "../displayName";
import {
  type ContextMenuSection,
  type ContextMenuQuickAction,
  useContextMenu,
} from "./ui/ContextMenu";

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
  trayIds = [],
  onRemoveFromTray,
  onReuse,
  onReuseGenerate,
  onSaveDraft,
  onSetMarker,
  onOpenViewer,
  concurrency,
  setConcurrency,
  maxConcurrency,
  phone = false,
}: {
  queue: QueueTask[];
  onRemove: (id: string) => void;
  onAbort: (id: string) => void;
  onClearDone: () => void;
  onUseAsRef: (img: ImageRow) => void;
  trayIds?: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  onReuse: (task: QueueTask) => void;
  onReuseGenerate: (task: QueueTask) => void;
  onSaveDraft: (task: QueueTask, move: boolean) => void;
  onSetMarker: (id: string, color: MarkerColor | null) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  concurrency: number;
  setConcurrency: (n: number) => void;
  maxConcurrency: number;
  phone?: boolean;
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
        {!phone && (
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
        )}
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
            trayIds={trayIds}
            onRemoveFromTray={onRemoveFromTray}
            onReuse={onReuse}
            onReuseGenerate={onReuseGenerate}
            onSaveDraft={onSaveDraft}
            onSetMarker={onSetMarker}
            onDefaultMarkerColor={setDefaultMarkerColor}
            onOpenViewer={onOpenViewer}
            phone={phone}
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
  trayIds,
  onRemoveFromTray,
  onReuse,
  onReuseGenerate,
  onSaveDraft,
  onSetMarker,
  onDefaultMarkerColor,
  onOpenViewer,
  phone,
}: {
  task: QueueTask;
  onRemove: (id: string) => void;
  onAbort: (id: string) => void;
  onUseAsRef: (img: ImageRow) => void;
  trayIds: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  onReuse: (task: QueueTask) => void;
  onReuseGenerate: (task: QueueTask) => void;
  onSaveDraft: (task: QueueTask, move: boolean) => void;
  onSetMarker: (id: string, color: MarkerColor | null) => void;
  onDefaultMarkerColor: (color: MarkerColor) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  phone: boolean;
}) {
  const { t, reason } = useI18n();
  const toast = useToast();
  const { open: openContextMenu } = useContextMenu();
  const series = useSeriesActions(useSeriesNav().onChanged);
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
  const [starred, setStarred] = useState(!!output?.starred);
  useEffect(() => {
    setStarred(!!output?.starred);
  }, [output?.id, output?.starred]);
  const failure =
    task.status === "blocked" || task.status === "error"
      ? reason(task.rawFinish, task.provider) ||
        task.message ||
        (task.status === "blocked" ? t("blocked_fallback") : t("error_fallback"))
      : task.status === "aborted"
      ? task.message || t("aborted_fallback")
      : null;
  // A skip is a neutral outcome, not a failure: no warning colour, no error icon.
  const skipped = task.status === "skipped";
  const meta = [task.model.replace("-image", "").replace("-preview", ""), task.aspectRatio, task.resolution]
    .filter(Boolean)
    .join(" · ");
  const runtime = active
    ? null
    : generationRuntime(task.durationMs, task.attempts, t);
  const statusLabel = task.interrupted ? t("remote_interrupted") : t(`status_${task.status}`);

  // Same fixed-slot layout as History cards so a queue row lines up; the
  // time-critical undo / cancel control sits in the media slot.
  const tools: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }[] = [
    { icon: "addToRefs", label: t("as_ref_short"), onClick: () => output && onUseAsRef(output), disabled: !output },
    {
      icon: "copy",
      label: t("copy_prompt"),
      onClick: async () => toast((await copyText(task.prompt)) ? t("copied") : t("copy_failed")),
      disabled: !task.prompt,
    },
    { icon: "download", label: t("download"), onClick: () => output && downloadImage(output), disabled: !output },
    { icon: "saveDraft", label: t("save_copy_to_drafts"), onClick: () => onSaveDraft(task, false) },
  ];

  const markerFooter = (close: () => void) => (
    <MarkerSwatches
      value={task.markerColor}
      onPick={(color) => {
        if (color) onDefaultMarkerColor(color);
        onSetMarker(task.id, color);
        close();
      }}
    />
  );

  const toggleStar = async () => {
    if (!output) return;
    const next = !starred;
    try {
      await api.patchImage(output.id, { starred: next });
      output.starred = next ? 1 : 0;
      setStarred(next);
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const openQueueImageMenu = (trigger: HTMLElement, x: number, y: number) => {
    if (!output) return;
    const quickActions: ContextMenuQuickAction[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: () => onOpenViewer(output, []),
      },
      {
        icon: trayIds.includes(output.id) ? "removeFromRefs" : "addToRefs",
        label: trayIds.includes(output.id) ? t("quick_action_remove_ref") : t("quick_action_input"),
        ariaLabel: trayIds.includes(output.id) ? t("remove_ref") : t("add_to_input"),
        onSelect: () => {
          if (trayIds.includes(output.id) && onRemoveFromTray) {
            onRemoveFromTray(output);
          } else {
            onUseAsRef(output);
          }
        },
      },
      {
        icon: "favorite",
        label: starred ? t("favorited") : t("favorite"),
        ariaLabel: starred ? t("unfavorite") : t("favorite"),
        selected: starred,
        filled: starred,
        onSelect: toggleStar,
      },
      {
        icon: "download",
        label: t("download"),
        onSelect: () => downloadImage(output),
      },
    ];
    const recordActions: ContextMenuSection = [];
    if (task.prompt) {
      recordActions.push({
        icon: "copy",
        label: t("copy_prompt"),
        onSelect: async () =>
          toast((await copyText(task.prompt)) ? t("copied") : t("copy_failed")),
      });
      recordActions.push({
        icon: "reuse",
        label: t("reuse"),
        onSelect: () => onReuse(task),
      });
      recordActions.push({
        icon: "rerun",
        label: t("rerun_short"),
        onSelect: () => onReuseGenerate(task),
      });
    }
    openContextMenu({
      x,
      y,
      trigger,
      images: [output],
      prompt: task.prompt,
      quickActions,
      sections: [
        recordActions,
        series.section([task.seriesId], {
          body: { imageIds: [output.id] },
          members: [task.seriesId ?? null],
        }),
      ].filter((section) => section.length > 0),
      ariaLabel: t("image_menu"),
    });
  };

  return (
    <article className="hcard grid">
      <div className={`hcard-media${failure ? ` failed ${task.status}` : ""}`}>
        {output ? (
          <img
            src={imgThumbUrl(output)}
            alt={displayName(output, t)}
            title={t("open_viewer")}
            onClick={() => onOpenViewer(output, [])}
            {...pressable(
              () => onOpenViewer(output, []),
              openQueueImageMenu,
            )}
          />
        ) : active ? (
          <>
            <div className={`q-shimmer${task.status !== "pending" ? " active" : ""}`} />
            <div className="hcard-status q-live">
              <span className="hcard-status-label">{statusLabel}</span>
              {substatus && <span>{substatus}</span>}
              {undoLeft > 0 ? (
                <button className="q-undo" title={t("undo_send_hint")} onClick={() => onRemove(task.id)}>
                  {t("undo_send", { n: undoLeft })}
                </button>
              ) : task.status === "running" ? (
                <button className="q-cancel" title={t("cancel_running_hint")} onClick={() => onAbort(task.id)}>
                  {t("cancel_running")}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <div className={`hcard-status${skipped ? " skipped" : ""}`}>
            <Icon name={skipped ? "info" : "warning"} />
            <span className="hcard-status-label">{statusLabel}</span>
            {(failure || (skipped && task.message)) && (
              <>
                <span className="hcard-status-reason">{failure ?? task.message}</span>
                <FullTextButton
                  label={t("details")}
                  title={statusLabel}
                  text={(failure ?? task.message) ?? ""}
                />
              </>
            )}
          </div>
        )}
      </div>
      <div className="hcard-body">
        <div className="hcard-meta">
          {task.markerColor && (
            <span className="hcard-marker" style={{ background: markerHex(task.markerColor) }} title={t("marker_label")} />
          )}
          <ProviderBadge provider={task.provider} />
          <span className="hcard-meta-text">{meta}</span>
          {runtime && <span className="hcard-runtime">{runtime}</span>}
          {task.seriesId ? (
            <SeriesBadge
              className="in-queue"
              seriesId={task.seriesId}
              subject={{ kind: "task", seriesId: task.seriesId, imageId: output?.id ?? null, clientTaskId: task.id }}
            />
          ) : null}
        </div>
        <PromptClamp text={task.prompt} lines={2} />
        <div className="hcard-chips">
          {task.inputs.map((im, i) => (
            <img
              key={im.id}
              src={imgThumbUrl(im)}
              alt={displayName(im, t)}
              {...peekProps(im, t("peek_input", { n: i + 1 }))}
              onClick={() => onOpenViewer(im, task.inputs)}
              {...pressable(() => onOpenViewer(im, task.inputs))}
            />
          ))}
        </div>
        <div className="hcard-actions">
          <Button size="sm" icon="reuse" onClick={() => onReuse(task)} title={t("reuse")}>
            <span className="hcard-btn-label">{t("reuse")}</span>
          </Button>
          <Button size="sm" icon="rerun" onClick={() => onReuseGenerate(task)} title={t("rerun_short")}>
            <span className="hcard-btn-label">{t("rerun_short")}</span>
          </Button>
          <div className="hcard-tools">
            {phone ? (
              <Menu
                items={[
                  ...tools.map((tool) => ({
                    icon: tool.icon,
                    label: tool.label,
                    disabled: tool.disabled,
                    onSelect: tool.onClick,
                  })),
                  task.status === "pending"
                    ? { icon: "moveToDrafts" as const, label: t("move_to_drafts"), onSelect: () => onSaveDraft(task, true) }
                    : { icon: "delete" as const, label: t("remove_task"), danger: true, disabled: active, onSelect: () => onRemove(task.id) },
                ]}
                footer={markerFooter}
                renderTrigger={({ open, toggle }) => (
                  <IconButton icon="more" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
                )}
              />
            ) : (
              <>
                {tools.map((tool) => (
                  <IconButton
                    key={tool.icon}
                    icon={tool.icon}
                    label={tool.label}
                    disabled={tool.disabled}
                    onClick={tool.onClick}
                  />
                ))}
                <Menu
                  items={[]}
                  footer={markerFooter}
                  renderTrigger={({ open, toggle }) => (
                    <IconButton icon="marker" label={t("choose_marker_color")} aria-expanded={open} onClick={toggle} />
                  )}
                />
                {task.status === "pending" ? (
                  <IconButton icon="moveToDrafts" label={t("move_to_drafts")} onClick={() => onSaveDraft(task, true)} />
                ) : (
                  <IconButton icon="delete" label={t("remove_task")} disabled={active} onClick={() => onRemove(task.id)} />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {series.dialog}
    </article>
  );
});
