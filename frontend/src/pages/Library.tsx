import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, downloadName, ImageRow, Tag, batchDownloadUrl, imgFileUrl, seriesApi } from "../api";
import { copyImageToClipboard } from "../clipboard";
import { useI18n } from "../i18n";
import SearchBox from "../components/SearchBox";
import TagFilterRow from "../components/TagFilterRow";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { useRemote } from "../remote";
import { RemoteChip } from "../components/RemoteIndicator";
import Icon from "../components/ui/Icon";
import Sheet from "../components/ui/Sheet";
import { Button, IconButton } from "../components/ui/Button";
import {
  type ContextMenuSection,
  type ContextMenuQuickAction,
  type ContextMenuTagSubmenu,
  useContextMenu,
} from "../components/ui/ContextMenu";
import appIcon from "../assets/app-icon.png";
import Segmented from "../components/ui/Segmented";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import type { ViewerPager } from "../components/ImageViewer";
import LibraryTile, { type LibraryTileActions } from "../components/LibraryTile";
import PositionLine from "../components/PositionLine";
import TimelineScrubber from "../components/LibraryScrubber";
import { CHUNK, useChunkedImages } from "../useChunkedImages";
import { useVirtualGrid } from "../useVirtualGrid";
import { monthYear, parseTime } from "../historyTime";
import { useTimeline } from "../useTimeline";
import { useAnchoredRefresh } from "../useAnchoredRefresh";
import { useRowHeightCheck } from "../useRowHeightCheck";
import { type SeriesTarget, useSeriesActions } from "../components/SeriesMenu";
import { fetchImageSeries, useImageSeries } from "../seriesContext";
import { useSeries } from "../seriesStore";
import Popover from "../components/ui/Popover";

const GRID_COLUMNS_KEY = "imagen-library-columns";
const GRID_COLUMN_OPTIONS = [1, 2, 3, 4, 5];
const THUMB_SIZE_KEY = "imagen-library-thumb";
const THUMB_SIZES = ["s", "m", "l"] as const;
type ThumbSize = (typeof THUMB_SIZES)[number];
// Fullscreen tiles: the minimum tile width, as CSS auto-fill used to have it.
const THUMB_MIN: Record<ThumbSize, number> = { s: 120, m: 170, l: 240 };
// Same cap as `/api/images/ids` (select all / Shift ranges).
const MAX_SELECT_IDS = 5000;
// Same cap as `/api/images/lookup`.
const LOOKUP_BATCH = 50;
// sessionStorage: where each Library layout was, by first visible image id.
const ANCHOR_KEY = "imagen-library-anchor:";
// Requests wait until scrolling pauses this long.
const ENSURE_DELAY_MS = 100;

function initialGridColumns() {
  const saved = Number(localStorage.getItem(GRID_COLUMNS_KEY));
  return GRID_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

function initialThumbSize(): ThumbSize {
  const saved = localStorage.getItem(THUMB_SIZE_KEY) as ThumbSize | null;
  return saved && THUMB_SIZES.includes(saved) ? saved : "m";
}

export default function Library({
  addToTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  onChanged,
  phone = false,
  onSelectModeChange,
  addManyToTray,
  trayIds = [],
  onRemoveFromTray,
  picker,
}: {
  addToTray: (img: ImageRow) => void;
  // One call for a whole selection. Without it, selections are added one by
  // one through `addToTray`, which must then be safe to call in a loop.
  addManyToTray?: (imgs: ImageRow[]) => void;
  trayIds?: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  // Picking images into a form (LibraryPickerModal): picked tiles keep a
  // numbered check that removes them again, deleting is hidden, and on the
  // phone a tap toggles the pick (a corner button opens the viewer).
  picker?: {
    pickedIds: number[];
    onUnpick: (img: ImageRow) => void;
  };
  onOpenViewer: (
    img: ImageRow,
    list: ImageRow[],
    pager?: ViewerPager,
    onIndexChange?: (globalIndex: number, image?: ImageRow) => void,
  ) => void;
  compact?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
  // Phone layout: full-width island with its own title row and floating
  // selection capsule. Reuses the same data and card logic as desktop.
  phone?: boolean;
  // Lets the phone shell hide the tab bar while a selection is active.
  onSelectModeChange?: (on: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const { open: openContextMenu } = useContextMenu();
  const { remote } = useRemote();
  const [tags, setTags] = useState<Tag[]>([]);
  const [source, setSource] = useState<string>("");
  // Phone: the search field stays folded until asked for (or while a query is active).
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<number | null>(null);
  const [columns, setColumns] = useState(initialGridColumns);
  const [thumbSize, setThumbSize] = useState<ThumbSize>(initialThumbSize);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchMode, setBatchMode] = useState<"add" | "remove" | null>(null);
  const [draft, setDraft] = useState("");
  // Phone only: tag batch actions live in a bottom sheet.
  const [batchSheet, setBatchSheet] = useState(false);
  // Timeline data is shared by the scrubber, position line and jump dialog.
  const [timelineTick, setTimelineTick] = useState(0);
  const [jumpOpen, setJumpOpen] = useState(false);
  // Long-press → multi-select on the phone. Timers live for the whole grid.
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  // Last clicked position, for Shift + click ranges.
  const lastClickIndex = useRef<number | null>(null);
  // Every row seen in this session, so a selection that spans far-away chunks
  // (already evicted) can still be turned into references.
  const rowsById = useRef(new Map<number, ImageRow>());
  const stickyRef = useRef<HTMLDivElement | null>(null);
  // Phone thumbnails offer 2/3/4 columns; a saved desktop width of 1 or 5 is
  // clamped here (the stored key stays the same on both layouts).
  const phoneColumns = Math.min(4, Math.max(2, columns));
  const effectiveColumns = phone ? phoneColumns : columns;
  const layoutKey = phone ? "phone" : compact ? "compact" : "full";

  const filters = useMemo(
    () => ({
      source: source || undefined,
      tag: tagFilter ?? undefined,
      starred: starredOnly || undefined,
      q: query.trim() || undefined,
    }),
    [source, tagFilter, starredOnly, query],
  );
  const filtersKey = JSON.stringify(filters);

  const data = useChunkedImages(filters, filtersKey, (rows) => {
    for (const img of rows) rowsById.current.set(img.id, img);
  });
  const total = data.total;

  // Timeline is shared by the scrubber, the position label and the jump
  // dialog. It is reloaded when the filters change and after a refresh.
  const {
    timeline,
    loading: timelineLoading,
    error: timelineError,
  } = useTimeline(() => api.imageTimeline(filters), filtersKey, timelineTick);

  const grid = useVirtualGrid({
    count: total,
    // Sidebar and phone keep their column buttons; fullscreen derives the
    // count from the tile size the way CSS auto-fill did.
    columns: compact ? effectiveColumns : undefined,
    minTile: THUMB_MIN[thumbSize],
    // Sticky headers (phone title row + toolbar) cover the top of the scroller.
    topInset: (scroller) => {
      const sticky = stickyRef.current;
      if (!sticky) return 0;
      return sticky.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    },
    topInsetTarget: stickyRef,
  });

  const loadTags = () => {
    api
      .listTags()
      .then((r) => setTags(r.tags))
      .catch(() => {});
  };
  useEffect(loadTags, [refreshKey]);

  // Fetch the rendered range once scrolling pauses; a drag or fling across
  // thousands of rows only shows skeletons on the way.
  useEffect(() => {
    if (!data.ready || total === 0) return;
    const timer = window.setTimeout(
      () => data.ensure(grid.startIndex, grid.endIndex),
      ENSURE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [data.ready, data.ensure, total, grid.startIndex, grid.endIndex]);

  const { refresh, newCount, clearNew } = useAnchoredRefresh({
    data,
    grid,
    idOf: (image) => image.id,
    filtersKey,
    refreshKey,
    storageKey: picker ? undefined : ANCHOR_KEY + layoutKey,
    onRefreshDone: () => setTimelineTick((n) => n + 1),
  });
  useRowHeightCheck({
    windowRef: grid.windowRef,
    expected: grid.itemHeight,
    selector: ".lib-tile",
    version: data.version,
  });

  useEffect(() => {
    localStorage.setItem(GRID_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(THUMB_SIZE_KEY, thumbSize);
  }, [thumbSize]);

  useEffect(() => {
    if (!phone) return;
    onSelectModeChange?.(selectMode);
    return () => onSelectModeChange?.(false);
  }, [phone, selectMode, onSelectModeChange]);

  const hasActiveFilters =
    !!query || starredOnly || !!source || tagFilter !== null;

  const clearFilters = () => {
    setQuery("");
    setStarredOnly(false);
    setSource("");
    setTagFilter(null);
  };

  const toggleStar = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: !img.starred });
      refresh();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const download = (img: ImageRow) => {
    const a = document.createElement("a");
    a.href = imgFileUrl(img);
    a.download = downloadName(img);
    a.click();
  };

  const copyImage = async (img: ImageRow) => {
    const ok = await copyImageToClipboard(img);
    toast(ok ? t("copied") : t("copy_image_failed"), ok ? "info" : "error");
  };

  const remove = async (img: ImageRow) => {
    const ok = await askConfirm({
      message: t("confirm_delete"),
      confirmLabel: t("move_to_bin"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteImage(img.id);
      refresh();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // The selection survives filter changes (as it did with pages), so its size
  // says nothing about the current result. "All selected" means: the ids the
  // last "Select all" fetched for these filters and this total are all still
  // selected. A new or deleted image changes the total and re-enables it.
  const [resultIds, setResultIds] = useState<{ key: string; total: number; ids: number[] } | null>(
    null,
  );
  const allSelected =
    total > 0 &&
    !!resultIds &&
    resultIds.key === filtersKey &&
    resultIds.total === total &&
    resultIds.ids.every((id) => selected.has(id));

  // "Select all" means the whole filtered result, not what is on screen.
  const selectAllResults = async () => {
    const key = filtersKey;
    try {
      const r = await api.listImageIds({ ...filters, limit: MAX_SELECT_IDS });
      setResultIds({ key, total: r.total, ids: r.ids });
      setSelected((s) => new Set([...s, ...r.ids]));
      if (r.total > r.ids.length) {
        toast(t("select_limit", { n: MAX_SELECT_IDS.toLocaleString() }), "info");
      }
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  // Shift + click: everything between the last clicked tile and this one,
  // including rows that were never loaded (one ids request fills the gap).
  const selectRange = async (to: number) => {
    const from = lastClickIndex.current ?? to;
    let start = Math.min(from, to);
    let end = Math.max(from, to);
    if (end - start + 1 > MAX_SELECT_IDS) {
      if (to < from) start = end - MAX_SELECT_IDS + 1;
      else end = start + MAX_SELECT_IDS - 1;
      toast(t("select_limit", { n: MAX_SELECT_IDS.toLocaleString() }), "info");
    }
    try {
      const ids = await data.idsInRange(start, end);
      setSelected((s) => new Set([...s, ...ids]));
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const onCardClick = (img: ImageRow, index: number, event: MouseEvent | null) => {
    // A long press already switched to selection; swallow the click it emits.
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (!phone && !picker && event?.shiftKey) {
      if (!selectMode) {
        setSelectMode(true);
        setSelected(new Set([img.id]));
        setBatchMode(null);
      } else if (lastClickIndex.current !== null) {
        selectRange(index);
      } else toggleSelect(img.id);
      lastClickIndex.current = index;
      return;
    }
    if (selectMode) {
      toggleSelect(img.id);
      lastClickIndex.current = index;
    } else if (picker && phone) togglePick(img);
    else openInViewer(img, index);
  };

  // Opens the viewer on the clicked image's chunk, paging through the whole
  // filtered result; the grid follows the viewer to wherever it ends up.
  const openInViewer = (img: ImageRow, index: number) => {
    const chunk = data.chunkAt(index);
    const list = chunk?.rows ?? [img];
    onOpenViewer(
      img,
      list,
      {
        offset: chunk ? chunk.offset : index,
        total,
        batchSize: CHUNK,
        fetch: async (nextOffset, limit) => {
          const r = await api.listImages({ ...filters, limit, offset: nextOffset });
          return r.images;
        },
      },
      (globalIndex) => {
        grid.scrollToIndex(globalIndex, "nearest");
        data.ensure(globalIndex, globalIndex);
      },
    );
  };

  const endLongPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  const startLongPress = (e: PointerEvent, img: ImageRow) => {
    if (!phone || selectMode || e.pointerType === "mouse") return;
    pressStart.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      setSelectMode(true);
      setSelected(new Set([img.id]));
    }, 450);
  };

  const moveLongPress = (e: PointerEvent) => {
    const start = pressStart.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 8 || Math.abs(e.clientY - start.y) > 8) {
      endLongPress();
    }
  };

  const stopSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setBatchMode(null);
    setBatchSheet(false);
    lastClickIndex.current = null;
  };

  const pickIndex = (id: number) => picker?.pickedIds.indexOf(id) ?? -1;
  const togglePick = (img: ImageRow) => {
    if (picker && pickIndex(img.id) >= 0) picker.onUnpick(img);
    else addToTray(img);
  };

  // Rows for ids, looking up the ones never loaded (select all / ranges).
  const rowsFor = async (ids: number[]): Promise<ImageRow[]> => {
    const missing = ids.filter((id) => !rowsById.current.has(id));
    for (let i = 0; i < missing.length; i += LOOKUP_BATCH) {
      const r = await api.lookupImages(missing.slice(i, i + LOOKUP_BATCH));
      for (const img of r.images) rowsById.current.set(img.id, img);
    }
    return ids
      .map((id) => rowsById.current.get(id))
      .filter((img): img is ImageRow => !!img);
  };
  const knownRows = (ids: Iterable<number>) =>
    [...ids]
      .map((id) => rowsById.current.get(id))
      .filter((img): img is ImageRow => !!img);

  // Selection order, not grid order: the first image tapped is reference 1.
  const useSelectedAsRefs = async () => {
    let rows: ImageRow[];
    try {
      rows = await rowsFor([...selected]);
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
      return;
    }
    if (rows.length === 0) return;
    if (addManyToTray) addManyToTray(rows);
    else for (const img of rows) addToTray(img);
    toast(t("refs_added_n", { n: rows.length }), "info");
    stopSelect();
  };

  const applyBatch = async (tagId: number) => {
    if (!batchMode || selected.size === 0) return;
    try {
      await api.batchTag([...selected], [tagId], batchMode);
      refresh();
      loadTags();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const downloadSelected = (ids: number[] = [...selected]) => {
    const a = document.createElement("a");
    a.href = batchDownloadUrl(ids);
    a.download = "imagen-images.zip";
    a.click();
  };

  const inTray = (img: ImageRow) => trayIds.includes(img.id);
  const toggleTray = (img: ImageRow) => {
    if (inTray(img) && onRemoveFromTray) onRemoveFromTray(img);
    else addToTray(img);
  };

  const tagOptions = (imgs: ImageRow[], onlyApplied = false) =>
    tags
      .filter(
        (tag) =>
          !onlyApplied ||
          imgs.some((img) => (img.tags ?? []).some((item) => item.id === tag.id)),
      )
      .map((tag) => ({
        id: tag.id,
        name: tag.name,
        count: tag.count,
        checked:
          imgs.length > 0 &&
          imgs.every((img) => (img.tags ?? []).some((item) => item.id === tag.id)),
      }));

  const afterTagChange = () => {
    refresh();
    loadTags();
  };

  const toggleImageTag = async (img: ImageRow, tagId: number) => {
    const on = (img.tags ?? []).some((tag) => tag.id === tagId);
    try {
      await api.batchTag([img.id], [tagId], on ? "remove" : "add");
      afterTagChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const createImageTag = async (img: ImageRow, name: string) => {
    try {
      const tag = await api.createTag(name);
      await api.batchTag([img.id], [tag.id], "add");
      afterTagChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const applyBatchTag = async (ids: number[], tagId: number, op: "add" | "remove") => {
    try {
      await api.batchTag(ids, [tagId], op);
      afterTagChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const createBatchTag = async (ids: number[], name: string) => {
    try {
      const tag = await api.createTag(name);
      await api.batchTag(ids, [tag.id], "add");
      afterTagChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  // `imgs` drives the checkmarks (rows we have); `ids` is what gets tagged.
  const batchTagSubmenu = (
    ids: number[],
    imgs: ImageRow[],
    op: "add" | "remove",
    allowCreate = false,
  ): ContextMenuTagSubmenu => ({
    kind: "tags",
    options: tagOptions(imgs, op === "remove"),
    onToggle: (tagId) => applyBatchTag(ids, tagId, op),
    ...(allowCreate
      ? {
          createLabel: t("new_tag_placeholder"),
          createPlaceholder: t("new_tag_placeholder"),
          onCreate: (name: string) => createBatchTag(ids, name),
        }
      : {}),
  });

  const removeMany = async (ids: number[]) => {
    if (ids.length === 0) return;
    const ok = await askConfirm({
      message: t("confirm_delete_n", { n: ids.length }),
      confirmLabel: t("move_to_bin"),
      danger: true,
    });
    if (!ok) return;
    try {
      const results = await Promise.allSettled(ids.map((id) => api.deleteImage(id)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      setSelected(new Set());
      refresh();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
      refresh();
      onChanged?.();
    }
  };

  // Library images are filed by the generation that produced them; uploads
  // with no generation cannot join a series.
  const series = useSeriesActions(() => onChanged?.());
  const [batchSeriesOpen, setBatchSeriesOpen] = useState(false);
  const [batchTarget, setBatchTarget] = useState<SeriesTarget | null>(null);
  const seriesTargetFor = async (ids: number[]): Promise<SeriesTarget | null> => {
    try {
      const items: Awaited<ReturnType<typeof seriesApi.membership>>["items"] = [];
      for (let i = 0; i < ids.length; i += 500) {
        items.push(...(await seriesApi.membership(ids.slice(i, i + 500))).items);
      }
      const filed = items.filter((item) => item.generationIds.length > 0);
      if (filed.length === 0) return null;
      return {
        body: { imageIds: filed.map((item) => item.imageId) },
        members: filed.map((item) => item.seriesIds[item.seriesIds.length - 1] ?? null),
      };
    } catch {
      return null;
    }
  };

  const openImageMenu = async (img: ImageRow, index: number, trigger: HTMLElement, x: number, y: number) => {
    if (selectMode) {
      let ids = selected;
      if (!ids.has(img.id)) {
        ids = new Set(ids);
        ids.add(img.id);
        setSelected(ids);
      }
      const idList = [...ids];
      const known = knownRows(idList);
      const images = known.length ? known : [img];
      const count = idList.length;
      const seriesTarget = await seriesTargetFor(idList);
      const folders: ContextMenuSection[] = [
        [
          {
            icon: "download",
            label: t("batch_download"),
            hint: ".zip",
            onSelect: () => downloadSelected(idList),
          },
          {
            icon: "tag",
            label: t("batch_add_tag"),
            submenu: batchTagSubmenu(idList, images, "add", true),
          },
          {
            icon: "untag",
            label: t("batch_remove_tag"),
            submenu: batchTagSubmenu(idList, images, "remove"),
          },
          series.menuItem(seriesTarget),
        ],
        [
          {
            icon: "delete",
            label: t("move_to_bin"),
            danger: true,
            hint: count,
            onSelect: () => removeMany(idList),
          },
        ],
      ];
      openContextMenu({
        x,
        y,
        trigger,
        images,
        title: t("picker_selected_n", { n: count }),
        subtitle: t("batch_actions"),
        sections: folders,
        ariaLabel: t("batch_actions"),
      });
      return;
    }

    const hasTags = (img.tags ?? []).length;
    const tagMenu: ContextMenuTagSubmenu = {
      kind: "tags",
      options: tagOptions([img]),
      onToggle: (tagId) => toggleImageTag(img, tagId),
      createLabel: t("new_tag_placeholder"),
      createPlaceholder: t("new_tag_placeholder"),
      onCreate: (name) => createImageTag(img, name),
    };
    const quickActionItems: ContextMenuQuickAction[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: () => openInViewer(img, index),
      },
      picker
        ? {
            // Picker (draft / history forms): the pick is a selection, not a
            // reference, and its state lives in `picker`, not in `trayIds`.
            icon: pickIndex(img.id) >= 0 ? "removeFromRefs" : "check",
            label: pickIndex(img.id) >= 0 ? t("unselect_image") : t("select_image"),
            onSelect: () => togglePick(img),
          }
        : {
            icon: inTray(img) ? "removeFromRefs" : "addToRefs",
            label: inTray(img) ? t("quick_action_remove_ref") : t("quick_action_input"),
            ariaLabel: inTray(img) ? t("remove_ref") : t("add_to_input"),
            onSelect: () => toggleTray(img),
          },
      {
        icon: "favorite",
        label: img.starred ? t("favorited") : t("favorite"),
        ariaLabel: img.starred ? t("unfavorite") : t("favorite"),
        selected: !!img.starred,
        filled: !!img.starred,
        onSelect: () => toggleStar(img),
      },
      {
        icon: "download",
        label: t("download"),
        onSelect: () => download(img),
      },
    ];
    const seriesTarget = img.source === "generated" ? await seriesTargetFor([img.id]) : null;
    const sections: ContextMenuSection[] = [
      [
        {
          icon: "copy",
          label: t("copy_image"),
          onSelect: () => copyImage(img),
        },
        {
          icon: "tag",
          label: t("tags_label"),
          hint: hasTags,
          submenu: tagMenu,
        },
        ...(!picker
          ? series.section(
              (await fetchImageSeries(img.id)).map((e) => e.seriesId),
              seriesTarget,
            )
          : []),
      ],
      ...(!picker
        ? [
            [
              {
                icon: "delete" as const,
                label: t("move_to_bin"),
                danger: true,
                onSelect: () => remove(img),
              },
            ],
          ]
        : []),
    ];
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      promptLoader:
        img.source === "generated"
          ? () => api.generationByOutput(img.id).then((generation) => generation?.prompt)
          : undefined,
      quickActions: quickActionItems,
      sections,
      ariaLabel: t("image_menu"),
    });
  };

  const createAndApply = async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      const tag = await api.createTag(name);
      setDraft("");
      if (selected.size > 0) await api.batchTag([...selected], [tag.id], "add");
      afterTagChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  // Tiles are memoized; they get one stable handler object that forwards to
  // this render's closures, so scrolling re-renders only the tiles that move
  // in or out of the window.
  const handlers = {
    onCardClick,
    openImageMenu,
    openInViewer,
    toggleStar,
    download,
    remove,
    startLongPress,
    moveLongPress,
    endLongPress,
    picker,
    addToTray,
    refresh,
  };
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const tileActions = useMemo<LibraryTileActions>(
    () => ({
      click: (img, index, event) => handlersRef.current.onCardClick(img, index, event),
      menu: (img, index, trigger, x, y) =>
        handlersRef.current.openImageMenu(img, index, trigger, x, y),
      openViewer: (img, index) => handlersRef.current.openInViewer(img, index),
      addRef: (img) => {
        handlersRef.current.addToTray(img);
        if (handlersRef.current.picker) return;
        setAdded(img.id);
        setTimeout(() => setAdded(null), 700);
      },
      unpick: (img) => handlersRef.current.picker?.onUnpick(img),
      star: (img) => handlersRef.current.toggleStar(img),
      download: (img) => handlersRef.current.download(img),
      remove: (img) => handlersRef.current.remove(img),
      pressStart: (event, img) => handlersRef.current.startLongPress(event, img),
      pressMove: (event) => handlersRef.current.moveLongPress(event),
      pressEnd: () => handlersRef.current.endLongPress(),
    }),
    [],
  );

  // Hover-to-enlarge for tiles small enough to need it. Mouse only (see
  // HoverPeek); the phone layout never attaches it.
  const peeks = !phone && (compact || thumbSize !== "l");

  // Used until the timeline arrives: month of the first visible image.
  const firstVisible = data.get(grid.visibleStart);
  const firstDate = parseTime(firstVisible?.created_at);
  const fallbackMonth = firstDate ? monthYear(firstDate, lang) : "";

  const jumpToIndex = (next: number) => {
    if (total === 0) return;
    const index = Math.max(0, Math.min(total - 1, next));
    grid.scrollToIndex(index, "start");
    data.ensure(index, Math.min(total - 1, index + Math.max(1, grid.cols) * 2));
    clearNew();
  };

  const sizePicker = (
    <div className="phone-size" role="group" aria-label={t("columns_per_row")}>
      {[2, 3, 4].map((n) => (
        <button
          key={n}
          type="button"
          className={phoneColumns === n ? "on" : ""}
          aria-pressed={phoneColumns === n}
          aria-label={t("phone_columns_n", { n })}
          onClick={() => setColumns(n)}
        >
          <i
            style={{
              gridTemplateColumns: `repeat(${n}, 1fr)`,
              gridTemplateRows: `repeat(${n}, 1fr)`,
            }}
          >
            {Array.from({ length: n * n }, (_, i) => (
              <b key={i} />
            ))}
          </i>
        </button>
      ))}
    </div>
  );

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
      unit="images"
      fallbackMonth={fallbackMonth}
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
    >
      {phone && sizePicker}
    </PositionLine>
  );

  // series-v2 B1a: series dots for the tiles on screen (input use counts).
  const visibleIds: number[] = [];
  for (let i = grid.startIndex; i <= grid.endIndex && total > 0; i++) {
    const img = data.get(i);
    if (img) visibleIds.push(img.id);
  }
  const imageSeries = useImageSeries(phone ? [] : visibleIds);
  const seriesStore = useSeries();
  const tileSeries = (id: number): string | undefined => {
    const entries = imageSeries(id);
    if (!entries?.length) return undefined;
    const list = entries.flatMap((e) => {
      const path = seriesStore.get(e.seriesId);
      return path ? [[path.color, path.name]] : [];
    });
    return list.length ? JSON.stringify(list) : undefined;
  };

  const tiles: JSX.Element[] = [];
  if (total > 0) {
    for (let i = grid.startIndex; i <= grid.endIndex; i++) {
      const img = data.get(i);
      tiles.push(
        img ? (
          <LibraryTile
            key={i}
            img={img}
            index={i}
            actions={tileActions}
            selected={selected.has(img.id)}
            selectMode={selectMode}
            pickAt={pickIndex(img.id)}
            justAdded={added === img.id}
            phone={phone}
            peeks={peeks}
            picker={!!picker}
            series={tileSeries(img.id)}
          />
        ) : (
          <div key={i} className="lib-skeleton" aria-hidden="true" />
        ),
      );
    }
  }

  // Scoped to the Library panel: Home / End never leak to the rest of the app,
  // and text fields keep their own caret behaviour.
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      grid.scrollToTop();
    } else if (event.key === "End") {
      event.preventDefault();
      const scroller = grid.scrollerRef.current;
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  };

  return (
    <div
      className={`panel library-panel${compact ? " compact" : ""}${phone ? " phone-panel-inner" : ""}`}
      onKeyDown={onPanelKeyDown}
    >
      {phone && (
        selectMode ? (
          <div className="phone-head phone-selhead">
            <button type="button" className="phone-textbtn" onClick={stopSelect}>
              {t("cancel")}
            </button>
            <b>{t("selected_n", { n: selected.size })}</b>
            <button
              type="button"
              className="phone-textbtn"
              disabled={total === 0 || allSelected}
              onClick={selectAllResults}
            >
              {t("select_all_results")}
            </button>
          </div>
        ) : (
          <div className="phone-head">
            <img className="phone-logo" src={appIcon} alt="" />
            <h1>
              {t("tab_library")} <span>{total}</span>
            </h1>
            {remote && <RemoteChip />}
            <IconButton
              icon="selectMode"
              label={t("select_mode")}
              onClick={() => {
                setSelectMode(true);
                setSelected(new Set());
                setBatchMode(null);
              }}
            />
          </div>
        )
      )}

      <div className="library-sticky" ref={stickyRef}>
        <div className="library-toolbar" hidden={phone && !searchOpen && !query}>
          <SearchBox
            autoFocus={phone && searchOpen && !query}
            value={query}
            onChange={(q) => {
              setQuery(q);
            }}
            placeholder={t("search_placeholder_library")}
          />
          {!phone && (
            <ViewPopover>
              {compact ? (
                <PopoverSection label={t("columns_per_row")}>
                  <Segmented
                    dense
                    value={columns}
                    onChange={(n) => {
                      setColumns(n);
                    }}
                    options={GRID_COLUMN_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
                  />
                </PopoverSection>
              ) : (
                <PopoverSection label={t("thumb_size_label")}>
                  <Segmented
                    dense
                    value={thumbSize}
                    onChange={setThumbSize}
                    options={THUMB_SIZES.map((s) => ({ value: s, label: s.toUpperCase() }))}
                  />
                </PopoverSection>
              )}
            </ViewPopover>
          )}
          {!phone && !selectMode && (
            <Button
              className="select-toggle"
              icon="selectMode"
              title={t("select_mode")}
              aria-label={t("select_mode")}
              onClick={() => {
                setSelectMode(true);
                setSelected(new Set());
                setBatchMode(null);
              }}
            >
              <span className="select-toggle-label">{t("select_mode")}</span>
            </Button>
          )}
        </div>

        {/* Filters stay on screen: one click each, no popover. On the phone the
            source chips drop their words (tooltips keep them). */}
        <div className={`filter-row${phone ? " phone-filter-row" : ""}`}>
          <Segmented
            value={source}
            onChange={(val) => {
              setSource(val);
            }}
            options={[
              { value: "", label: t("filter_all") },
              { value: "upload", label: t("filter_upload"), icon: "uploaded", iconOnly: phone },
              { value: "generated", label: t("filter_output"), icon: "output", title: t("filter_output_hint"), iconOnly: phone },
              { value: "app", label: t("filter_in_app"), icon: "generated", iconOnly: phone },
              { value: "imported", label: t("filter_imported"), icon: "imported", iconOnly: phone },
            ]}
          />
          <Button
            className={`skip-toggle${starredOnly ? " on" : ""}`}
            icon="favorite"
            title={t("filter_starred_only")}
            aria-label={t("filter_starred_only")}
            aria-pressed={starredOnly}
            onClick={() => {
              setStarredOnly((v) => !v);
            }}
          >
            <span className="filter-label">{t("filter_starred_only")}</span>
          </Button>
          {phone && (
            <Button
              className={`skip-toggle phone-search-toggle${searchOpen || query ? " on" : ""}`}
              icon="search"
              title={t("search")}
              aria-label={t("search")}
              aria-pressed={searchOpen || !!query}
              onClick={() => {
                if (searchOpen || query) {
                  setSearchOpen(false);
                  setQuery("");
                } else setSearchOpen(true);
              }}
            />
          )}
        </div>

        {/* Tag filter bar (collection-style) */}
        <TagFilterRow
          tags={tags}
          value={tagFilter}
          phone={phone}
          total={total}
          onChange={(id) => {
            setTagFilter(id);
          }}
        />

        {/* Batch tagging bar (desktop; on the phone it lives in a sheet). */}
        {!phone && selectMode && (
          <div className="batch-bar">
            <div className="batch-bar-row">
              <span className="batch-count">{t("selected_n", { n: selected.size })}</span>
              <Button
                variant="link"
                disabled={total === 0 || allSelected}
                onClick={selectAllResults}
              >
                {t("select_all_results")}
              </Button>
              {selected.size > 0 && (
                <Button variant="link" onClick={() => setSelected(new Set())}>
                  {t("deselect_all")}
                </Button>
              )}
              <div className="spacer" />
              <Button
                variant="primary"
                size="sm"
                icon="check"
                className="batch-done"
                title={t("done")}
                aria-label={t("done")}
                onClick={stopSelect}
              >
                <span className="batch-btn-label">{t("done")}</span>
              </Button>
            </div>
            <div className="batch-bar-row">
              <div className="btn-group" role="group" aria-label={t("tags_label")}>
                <Button
                  size="sm"
                  icon="tag"
                  className={batchMode === "add" ? "on" : ""}
                  aria-pressed={batchMode === "add"}
                  title={t("batch_add_tag")}
                  aria-label={t("batch_add_tag")}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "add" ? null : "add")}
                >
                  <span className="batch-btn-label">{t("batch_add_tag")}</span>
                </Button>
                <Button
                  size="sm"
                  icon="untag"
                  className={batchMode === "remove" ? "on" : ""}
                  aria-pressed={batchMode === "remove"}
                  title={t("batch_remove_tag")}
                  aria-label={t("batch_remove_tag")}
                  disabled={selected.size === 0}
                  onClick={() => setBatchMode(batchMode === "remove" ? null : "remove")}
                >
                  <span className="batch-btn-label">{t("batch_remove_tag")}</span>
                </Button>
              </div>
              <Popover
                fixed
                align="start"
                open={batchSeriesOpen && !!batchTarget}
                onClose={() => setBatchSeriesOpen(false)}
                panelClassName="series-popover"
                panelProps={{ role: "dialog", "aria-label": t("series_add_to") }}
                trigger={
                  <Button
                    size="sm"
                    icon="series"
                    title={t("series_add_to_ellipsis")}
                    aria-label={t("series_add_to_ellipsis")}
                    aria-expanded={batchSeriesOpen}
                    disabled={selected.size === 0}
                    onClick={async () => {
                      if (batchSeriesOpen) {
                        setBatchSeriesOpen(false);
                        return;
                      }
                      const target = await seriesTargetFor([...selected]);
                      if (!target) {
                        toast(t("series_upload_hint"));
                        return;
                      }
                      setBatchTarget(target);
                      setBatchSeriesOpen(true);
                    }}
                  >
                    <span className="batch-btn-label">{t("series_add_to_ellipsis")}</span>
                  </Button>
                }
              >
                {batchTarget && series.picker(batchTarget, () => setBatchSeriesOpen(false), true)}
              </Popover>
              <Button
                size="sm"
                icon="download"
                title={t("batch_download")}
                aria-label={t("batch_download")}
                disabled={selected.size === 0}
                onClick={() => downloadSelected()}
              >
                <span className="batch-btn-label">{t("batch_download")}</span>
              </Button>
              <Button
                size="sm"
                icon="addToRefs"
                variant={picker ? "primary" : undefined}
                title={t("batch_add_ref")}
                aria-label={t("batch_add_ref")}
                disabled={selected.size === 0}
                onClick={useSelectedAsRefs}
              >
                <span className="batch-btn-label">{t("batch_add_ref")}</span>
              </Button>
            </div>
          </div>
        )}
        {!phone && selectMode && batchMode && selected.size > 0 && (
          <div className="batch-tags">
            <div className="batch-section">
              <span className="batch-section-title">{t("apply_to_selected")}</span>
              <div className="tag-chip-row">
                {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    className="tag-chip"
                    onClick={() => applyBatch(tag.id)}
                  >
                    <Icon name={batchMode === "add" ? "add" : "remove"} size="sm" /> {tag.name}
                    <span className="tag-count">{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
            {batchMode === "add" && (
              <div className="batch-section">
                <span className="batch-section-title">{t("create_new_tag")}</span>
                <div className="tag-create">
                  <input
                    value={draft}
                    placeholder={t("new_tag_placeholder")}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        createAndApply();
                      }
                    }}
                  />
                  <button onClick={createAndApply} disabled={!draft.trim()}>
                    {t("create")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {positionLine}
      </div>

      {!data.ready ? (
        <p className="muted">
          <span className="spinner" /> {t("loading")}
        </p>
      ) : data.error && total === 0 ? (
        <div className="load-error">
          <span className="small">{t("load_error", { msg: data.error })}</span>
          <button onClick={data.reset}>{t("retry")}</button>
        </div>
      ) : total === 0 ? (
        hasActiveFilters ? (
          <div className="empty-state">
            <p className="muted">{t("no_results")}</p>
            <button onClick={clearFilters}>{t("clear_filters")}</button>
          </div>
        ) : (
          <p className="muted">{t("lib_empty")}</p>
        )
      ) : data.error ? (
        <div className="load-error">
          <span className="small">{t("load_error", { msg: data.error })}</span>
          <button onClick={() => data.ensure(grid.startIndex, grid.endIndex)}>{t("retry")}</button>
        </div>
      ) : null}

      {/* One continuous grid, virtualized by rows: the outer element has the
          height of every row, the inner window holds only the rows near the
          viewport. Always mounted so it can be measured before data arrives. */}
      <div className="library-vgrid" ref={grid.gridRef} style={{ height: grid.totalHeight }}>
        <div
          ref={grid.windowRef}
          className={`grid library-grid${compact ? " compact" : " full"}${phone ? ` phone-grid phone-cols-${phoneColumns}` : ""}${
            phone && phoneColumns === 4 ? " cols-4" : ""
          }`}
          style={
            {
              gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
              gridAutoRows: grid.itemHeight > 0 ? `${grid.itemHeight}px` : undefined,
              transform: `translateY(${grid.offsetY}px)`,
            } as CSSProperties
          }
        >
          {tiles}
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

      {phone && selectMode && (
        <nav className="phone-selbar" aria-label={t("apply_to_selected")}>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={useSelectedAsRefs}
          >
            <Icon name="addToRefs" />
            <span>{t("phone_use_as_ref")}</span>
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => {
              setBatchMode("add");
              setBatchSheet(true);
            }}
          >
            <Icon name="tag" />
            <span>{t("tags_label")}</span>
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => downloadSelected()}
          >
            <Icon name="download" />
            <span>{t("batch_download")}</span>
          </button>
        </nav>
      )}

      {phone && batchSheet && (
        <Sheet
          title={t("phone_batch_tags")}
          onClose={() => setBatchSheet(false)}
          footer={
            <button
              type="button"
              className="btn primary"
              style={{ flex: 1 }}
              onClick={() => setBatchSheet(false)}
            >
              {t("done")}
            </button>
          }
        >
          <div className="sheet-field">
            <span className="lab">
              {t("apply_to_selected")} · {t("selected_n", { n: selected.size })}
            </span>
            <div className="phone-batch-mode">
              <button
                type="button"
                className={batchMode === "add" ? "on" : ""}
                onClick={() => setBatchMode("add")}
              >
                <Icon name="add" size="sm" />
                {t("batch_add_tag")}
              </button>
              <button
                type="button"
                className={batchMode === "remove" ? "on" : ""}
                onClick={() => setBatchMode("remove")}
              >
                <Icon name="remove" size="sm" />
                {t("batch_remove_tag")}
              </button>
            </div>
          </div>
          <div className="sheet-tag-wrap">
            {tags.length === 0 && <span className="muted small">{t("no_tags")}</span>}
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="tag-chip"
                onClick={() => {
                  applyBatch(tag.id);
                  setBatchSheet(false);
                }}
              >
                <Icon name={batchMode === "remove" ? "remove" : "add"} size="sm" /> {tag.name}
                <span className="tag-count">{tag.count}</span>
              </button>
            ))}
          </div>
          {batchMode === "add" && (
            <div className="sheet-field">
              <span className="lab">{t("create_new_tag")}</span>
              <div className="tag-create">
                <input
                  value={draft}
                  placeholder={t("new_tag_placeholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      createAndApply().then(() => setBatchSheet(false));
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => createAndApply().then(() => setBatchSheet(false))}
                  disabled={!draft.trim()}
                >
                  {t("create")}
                </button>
              </div>
            </div>
          )}
        </Sheet>
      )}
      {series.dialog}
    </div>
  );
}
