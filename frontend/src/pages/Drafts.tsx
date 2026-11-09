import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Draft,
  draftToTaskSpec,
  type DraftFilters,
  type ImageRow,
  providerOf,
  type TaskSpec,
} from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import DraftEditorModal from "../components/DraftEditorModal";
import SearchBox from "../components/SearchBox";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import GenerationCard, { downloadImage } from "../components/GenerationCard";
import type { MenuItem } from "../components/ui/Menu";
import { IconButton } from "../components/ui/Button";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import Segmented from "../components/ui/Segmented";
import {
  type ContextMenuQuickAction,
  useContextMenu,
} from "../components/ui/ContextMenu";
import PositionLine from "../components/PositionLine";
import TimelineScrubber from "../components/LibraryScrubber";
import { useChunkedList } from "../useChunkedList";
import { useVirtualGrid } from "../useVirtualGrid";
import { useAnchoredRefresh } from "../useAnchoredRefresh";
import { useTimeline } from "../useTimeline";
import { useRowHeightCheck } from "../useRowHeightCheck";

// Use a new key so the previous single-column-only view does not carry a
// legacy saved value into the new two-column default.
const DRAFT_COLUMNS_KEY = "imagen-draft-columns-v2";
const DRAFT_ANCHOR_KEY = "imagen-drafts-anchor:";
const DRAFT_COLUMN_OPTIONS = [1, 2, 3];
const ENSURE_DELAY_MS = 100;

function initialDraftColumns() {
  const saved = Number(localStorage.getItem(DRAFT_COLUMNS_KEY));
  return DRAFT_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

function cssPx(
  element: HTMLElement | null,
  property: string,
  fallback: number,
) {
  if (!element) return fallback;
  const value = parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

export default function Drafts({
  compact = false,
  refreshKey = 0,
  onQueue,
  onUnqueue,
  onOpenViewer,
  onAddToTray,
  trayIds = [],
  onRemoveFromTray,
  onChanged,
  phone = false,
}: {
  compact?: boolean;
  refreshKey?: number;
  // Returns the client queue id of the task it just added.
  onQueue: (task: TaskSpec) => string;
  // Removes an added task if it has not been sent yet.
  onUnqueue?: (id: string) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onAddToTray?: (img: ImageRow) => void;
  trayIds?: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  // Called after a draft is created or removed, so counts elsewhere refresh.
  onChanged?: () => void;
  phone?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { isReady } = useProviders();
  const askConfirm = useConfirm();
  const { open: openContextMenu } = useContextMenu();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [columns, setColumns] = useState(initialDraftColumns);
  const [timelineTick, setTimelineTick] = useState(0);
  const [jumpOpen, setJumpOpen] = useState(false);
  const stickyRef = useRef<HTMLDivElement>(null);
  const layoutKey = phone ? "phone" : compact ? "compact" : "full";

  const filters = useMemo<DraftFilters>(
    () => ({ q: query.trim() || undefined }),
    [query],
  );
  const filtersKey = JSON.stringify(filters);
  const data = useChunkedList<Draft>({
    key: filtersKey,
    fetchChunk: async (offset, limit, signal) => {
      const result = await api.listDrafts(
        { ...filters, limit, offset },
        signal,
      );
      return { rows: result.drafts, total: result.total };
    },
    fetchIds: async (offset, limit, signal) =>
      (
        await api.listDrafts(
          { ...filters, offset, limit },
          signal,
        )
      ).drafts.map((draft) => draft.id),
    idOf: (draft) => draft.id,
  });
  const total = data.total;
  const loading = !data.ready;
  const loadError = data.error;
  const {
    timeline,
    loading: timelineLoading,
    error: timelineError,
  } = useTimeline(
    () => api.draftsTimeline(filters),
    filtersKey,
    timelineTick,
  );
  const grid = useVirtualGrid({
    count: total,
    columns: phone ? 1 : columns,
    itemHeight: (width, element) =>
      Math.max(0, width - 2) * 0.75 +
      cssPx(element, "--gcard-body-h", 200) +
      2,
    topInset: (scroller) => {
      const sticky = stickyRef.current;
      if (!sticky) return 0;
      return sticky.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    },
    topInsetTarget: stickyRef,
  });
  const { refresh, newCount, clearNew } = useAnchoredRefresh({
    data,
    grid,
    idOf: (draft) => draft.id,
    filtersKey,
    refreshKey,
    storageKey: `${DRAFT_ANCHOR_KEY}${layoutKey}`,
    onRefreshDone: () => setTimelineTick((n) => n + 1),
  });
  useRowHeightCheck({
    windowRef: grid.windowRef,
    expected: grid.itemHeight,
    selector: ".gcard",
    version: data.version,
  });

  useEffect(() => {
    if (!data.ready || total === 0) return;
    const timer = window.setTimeout(
      () => data.ensure(grid.startIndex, grid.endIndex),
      ENSURE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [data.ready, data.ensure, grid.endIndex, grid.startIndex, total]);

  useEffect(() => {
    localStorage.setItem(DRAFT_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    setJumpOpen(false);
  }, [filtersKey]);

  const togglePin = async (draft: Draft) => {
    try {
      await api.updateDraft(draft.id, { pinned: !draft.pinned });
      void refresh();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const restoreDraft = async (draft: Draft, queueId: string) => {
    try {
      await api.createDraft({
        prompt: draft.prompt,
        provider: providerOf(draft),
        model: draft.model,
        aspectRatio: draft.aspect_ratio,
        resolution: draft.resolution,
        outputFormat: draft.output_format,
        skipIfPrecedingSucceeds: !!draft.skip_if_preceding_succeeds,
        pinned: !!draft.pinned,
        inputImageIds: draft.inputImages.map((img) => img.id),
        outputImageIds: draft.outputImages.map((img) => img.id),
        tagIds: draft.tags.map((tag) => tag.id),
        seriesId: draft.series_id ?? null,
      });
      // Pending tasks are removed; a task that has already been sent stays.
      onUnqueue?.(queueId);
      toast(t("draft_restored"), "success");
      void refresh();
      onChanged?.();
    } catch (e) {
      toast(t("draft_restore_failed", { msg: (e as Error).message }));
    }
  };

  const queueDraft = async (draft: Draft, removeAfter: boolean) => {
    // Each draft is queued on its own provider, so readiness is per draft.
    if (!isReady(providerOf(draft))) {
      toast(t("draft_need_config"));
      return;
    }
    if (!draft.prompt.trim() && draft.inputImages.length === 0) {
      toast(t("draft_need_content"));
      return;
    }
    if (draft.inputImages.some((img) => !!img.deleted_at)) {
      toast(t("draft_deleted_input"));
      return;
    }
    const queueId = onQueue(draftToTaskSpec(draft));
    if (!removeAfter) {
      toast(t("draft_queued_kept"), "success");
      return;
    }
    try {
      await api.deleteDraft(draft.id);
      void refresh();
      onChanged?.();
      toast(t("draft_queued_deleted"), "success", {
        durationMs: 8000,
        action: { label: t("undo"), onClick: () => void restoreDraft(draft, queueId) },
      });
    } catch (e) {
      toast(t("draft_queued_delete_failed", { msg: (e as Error).message }));
    }
  };

  const deleteDraft = async (draft: Draft) => {
    const ok = await askConfirm({ message: t("confirm_delete_draft_q"), confirmLabel: t("delete"), danger: true });
    if (!ok) return;
    try {
      await api.deleteDraft(draft.id);
      void refresh();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleDraftImage = async (img: ImageRow) => {
    const next = !img.starred;
    try {
      await api.patchImage(img.id, { starred: next });
      img.starred = next ? 1 : 0;
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const openDraftImageMenu = (
    draft: Draft,
    img: ImageRow,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => {
    const isOutput = draft.outputImages.some((item) => item.id === img.id);
    const inTray = trayIds.includes(img.id);
    const quickActions: ContextMenuQuickAction[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: () =>
          onOpenViewer(
            img,
            isOutput
              ? draft.outputImages.filter((item) => !item.deleted_at)
              : draft.inputImages.filter((item) => !item.deleted_at),
          ),
      },
      ...(onAddToTray
        ? [
            {
              icon: inTray ? ("removeFromRefs" as const) : ("addToRefs" as const),
              label: inTray ? t("quick_action_remove_ref") : t("quick_action_input"),
              ariaLabel: inTray ? t("remove_ref") : t("add_to_input"),
              onSelect: () => {
                if (inTray && onRemoveFromTray) onRemoveFromTray(img);
                else onAddToTray(img);
              },
            },
          ]
        : []),
      {
        icon: "favorite",
        label: img.starred ? t("favorited") : t("favorite"),
        ariaLabel: img.starred ? t("unfavorite") : t("favorite"),
        selected: !!img.starred,
        filled: !!img.starred,
        onSelect: () => toggleDraftImage(img),
      },
      {
        icon: "download",
        label: t("download"),
        onSelect: () => downloadImage(img),
      },
    ];
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      prompt: draft.prompt,
      quickActions,
      sections: [],
      ariaLabel: t("image_menu"),
    });
  };

  const jumpToIndex = (next: number) => {
    if (total === 0) return;
    const index = Math.max(0, Math.min(total - 1, next));
    grid.scrollToIndex(index, "start");
    data.ensure(index, Math.min(total - 1, index + Math.max(1, grid.cols)));
    clearNew();
  };

  const positionLine = (
    <PositionLine
      total={total}
      index={grid.visibleStart}
      endIndex={grid.visibleEnd}
      atTop={grid.atTop}
      timeline={timeline}
      timelineLoading={timelineLoading}
      timelineError={timelineError}
      phone={phone}
      unit="drafts"
      buttonClass="list-position"
      newCount={newCount}
      jumpOpen={jumpOpen}
      onJumpOpenChange={setJumpOpen}
      onJump={jumpToIndex}
      onBackToTop={() => {
        clearNew();
        grid.scrollToTop(true);
      }}
      onNewClick={() => {
        clearNew();
        grid.scrollToTop(true);
      }}
    />
  );

  return (
    <div className="drafts-page">
      <div className="draft-toolbar" ref={stickyRef}>
        <SearchBox
          value={query}
          onChange={(value) => setQuery(value)}
          placeholder={t("search_placeholder_drafts")}
        />
        <IconButton
          className="draft-new-button"
          variant="outline"
          size="md"
          icon="add"
          label={t("new_draft")}
          onClick={() => setCreating(true)}
        />
        {!phone && (
          <ViewPopover>
            <PopoverSection label={t("columns_per_row")}>
              <Segmented
                dense
                value={columns}
                onChange={(n) => {
                  setColumns(n);
                }}
                options={DRAFT_COLUMN_OPTIONS.map((value) => ({ value, label: String(value) }))}
              />
            </PopoverSection>
          </ViewPopover>
        )}
        {positionLine}
      </div>

      {loading ? (
        <div className="panel muted"><span className="spinner" /> {t("loading")}</div>
      ) : loadError ? (
        total === 0 ? (
          <div className="panel load-error">
            <span className="small">{t("load_error", { msg: loadError })}</span>
            <button onClick={data.reset}>{t("retry")}</button>
          </div>
        ) : (
          <div className="load-error">
            <span className="small">{t("load_error", { msg: loadError })}</span>
            <button onClick={() => data.ensure(grid.startIndex, grid.endIndex)}>
              {t("retry")}
            </button>
          </div>
        )
      ) : total === 0 ? (
        <div className="panel muted empty-state">
          <span>{query ? t("no_results") : t("drafts_empty")}</span>
          {query && <button onClick={() => setQuery("")}>{t("clear_filters")}</button>}
        </div>
      ) : null}

      <div
        className="drafts-vgrid virtual-list"
        ref={grid.gridRef}
        style={{ height: grid.totalHeight }}
      >
        <div
          ref={grid.windowRef}
          className={`draft-list${compact ? " compact" : ""}`}
          style={
            {
              "--draft-columns": grid.cols,
              gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
              gridAutoRows:
                grid.itemHeight > 0 ? `${grid.itemHeight}px` : undefined,
              transform: `translateY(${grid.offsetY}px)`,
            } as CSSProperties
          }
        >
          {Array.from(
            { length: Math.max(0, grid.endIndex - grid.startIndex + 1) },
            (_, offset) => {
              const index = grid.startIndex + offset;
              const draft = data.get(index);
              if (!draft) {
                return (
                  <div key={index} className="lib-skeleton" aria-hidden="true" />
                );
              }
              const firstOutput =
                draft.outputImages.find((img) => !img.deleted_at) ?? null;
              const liveOutputs = draft.outputImages.filter(
                (img) => !img.deleted_at,
              );
              const menuItems: MenuItem[] = [
                {
                  icon: "editSettings",
                  label: t("edit_draft"),
                  onSelect: () => setEditing(draft),
                },
                {
                  icon: "queue",
                  label: t("queue_and_keep"),
                  onSelect: () => queueDraft(draft, false),
                },
                {
                  icon: "pin",
                  label: draft.pinned ? t("unpin_draft") : t("pin_draft"),
                  onSelect: () => togglePin(draft),
                },
                {
                  icon: "delete",
                  label: t("delete"),
                  danger: true,
                  onSelect: () => deleteDraft(draft),
                },
              ];
              return (
                <div key={draft.id} className="draft-cell">
                  <GenerationCard
                    fixed
                    media={
                      firstOutput
                        ? {
                            kind: "image",
                            image: firstOutput,
                            onOpen: () => onOpenViewer(firstOutput, liveOutputs),
                          }
                        : { kind: "empty" }
                    }
                    aspectRatio={draft.aspect_ratio}
                    extraBadges={
                      liveOutputs.length > 1 && (
                        <span className="badge imported" title={t("draft_outputs")}>
                          {t("draft_outputs_n", { n: liveOutputs.length })}
                        </span>
                      )
                    }
                    overlay={
                      <IconButton
                        variant={firstOutput ? "overlay" : "ghost"}
                        className={`draft-pin${draft.pinned ? " is-pinned" : ""}`}
                        icon="pin"
                        filled={!!draft.pinned}
                        label={draft.pinned ? t("unpin_draft") : t("pin_draft")}
                        aria-pressed={!!draft.pinned}
                        onClick={() => togglePin(draft)}
                      />
                    }
                    provider={providerOf(draft)}
                    meta={[
                      draft.model.replace("-image", ""),
                      draft.aspect_ratio,
                      draft.resolution,
                    ]}
                    prompt={draft.prompt}
                    promptLines={4}
                    inputs={draft.inputImages}
                    onOpenInput={(img) =>
                      onOpenViewer(
                        img,
                        draft.inputImages.filter((item) => !item.deleted_at),
                      )
                    }
                    onImageContextMenu={(img, trigger, x, y) =>
                      openDraftImageMenu(draft, img, trigger, x, y)
                    }
                    tags={draft.tags}
                    actions={[
                      {
                        icon: "queue",
                        label: t("draft_queue_short"),
                        title: t("queue_and_delete_hint"),
                        primary: true,
                        onClick: () => queueDraft(draft, true),
                      },
                    ]}
                    menuItems={menuItems}
                  />
                </div>
              );
            },
          )}
        </div>
      </div>

      <TimelineScrubber
        mode={phone ? "phone" : compact ? "compact" : "full"}
        total={total}
        index={grid.visibleStart}
        step={Math.max(1, grid.visibleEnd - grid.visibleStart + 1)}
        timeline={timeline}
        scrollerRef={grid.scrollerRef}
        headerRef={stickyRef}
        onSeek={(index) => grid.scrollToIndex(index, "start")}
        onLongPress={phone ? () => setJumpOpen(true) : undefined}
      />

      {creating && (
        <DraftEditorModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            void refresh();
            onChanged?.();
          }}
        />
      )}
      {editing && (
        <DraftEditorModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}

