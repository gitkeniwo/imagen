import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  DraftBody,
  ImageRow,
  Generation,
  MarkerColor,
  MAX_TASK_ATTEMPTS,
  QueueTask,
  TaskSpec,
} from "./api";
import { useI18n } from "./i18n";
import Generate from "./pages/Generate";
import Library from "./pages/Library";
import History from "./pages/History";
import Favorites from "./pages/Favorites";
import SettingsModal from "./components/SettingsModal";
import RemoteIndicator, { RemoteChip } from "./components/RemoteIndicator";
import { useRemote } from "./remote";
import AddHistoryModal from "./components/AddHistoryModal";
import UsageDashboard from "./components/UsageDashboard";
import ImageViewer from "./components/ImageViewer";
import HoverPeek from "./components/HoverPeek";
import FullscreenManager, { type ManagerPanel } from "./components/FullscreenManager";
import Drafts from "./pages/Drafts";
import Bin from "./pages/Bin";
import PhoneTabBar, { type PhoneTab } from "./components/PhoneTabBar";
import MoreMenu, { type MorePage } from "./components/MoreMenu";
import { useIsPhone } from "./useIsPhone";
import PanelTabs from "./components/ui/PanelTabs";
import { usePanelCounts } from "./usePanelCounts";
import { useToast } from "./components/Toast";
import Icon from "./components/ui/Icon";
import { Button, IconButton } from "./components/ui/Button";
import appIcon from "./assets/app-icon.png";
import { isRefDrag } from "./imageDrag";
import { uuid } from "./uuid";

export type SidebarPanel = "library" | "history" | "favorites" | "drafts";

export interface Prefill {
  prompt: string;
  model: string;
  aspectRatio: string | null;
  resolution: string | null;
}

// Concurrency is user-adjustable (see CONCURRENCY_KEY). Default 1 = serial:
// preview models like Nano Banana Pro have very low quota, and several requests
// in flight mutually starve the quota bucket → all get 429 → all stall. Serial
// lets a single request land within quota. The cap also keeps us well under the
// browser's ~6 HTTP/1.1 connections-per-host limit (each /api/generate is
// long-lived: server-side retry/backoff can hold it open for minutes).
const CONCURRENCY_KEY = "imagen-max-concurrency";
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 5;
// "Undo send" window: a submitted task counts down this many seconds before the
// request is actually dispatched to Vertex. Cancelling within the window is a
// guaranteed no-charge (nothing was sent). 0 = send immediately.
const UNDO_SECONDS_KEY = "imagen-undo-send-seconds";
const DEFAULT_UNDO_SECONDS = 5;
const SIDEBAR_WIDTH_KEY = "imagen-sidebar-width";
const PHONE_TAB_KEY = "imagen-phone-tab";
const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 260;
const SIDEBAR_MAX_RATIO = 0.7;

// 640–920px (tablet split view, narrow desktop windows): start narrower so the
// main column keeps usable width. Only the unset default is affected; a width
// the user dragged and saved is used as-is.
function defaultSidebarWidth() {
  if (window.innerWidth < 920) {
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(DEFAULT_SIDEBAR_WIDTH, Math.round(window.innerWidth * 0.45)),
    );
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function initialSidebarWidth() {
  // Number(null) is 0, so an unset key must be caught before coercion or the
  // default is silently replaced by the clamp floor.
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (raw === null) return defaultSidebarWidth();
  const saved = Number(raw);
  return Number.isFinite(saved) && saved > 0
    ? Math.max(MIN_SIDEBAR_WIDTH, saved)
    : defaultSidebarWidth();
}

function initialPhoneTab(): PhoneTab {
  const saved = localStorage.getItem(PHONE_TAB_KEY);
  return saved === "create" || saved === "history" || saved === "more"
    ? saved
    : "library";
}

function initialConcurrency() {
  const v = Number(localStorage.getItem(CONCURRENCY_KEY));
  return Number.isInteger(v) && v >= 1 && v <= MAX_CONCURRENCY
    ? v
    : DEFAULT_CONCURRENCY;
}

function initialUndoSeconds() {
  // An unset key must yield the default: Number(null) is 0, which would pass
  // the range check and silently disable the undo-send window for new users.
  const raw = localStorage.getItem(UNDO_SECONDS_KEY);
  if (raw === null) return DEFAULT_UNDO_SECONDS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 60 ? v : DEFAULT_UNDO_SECONDS;
}

export default function App() {
  const { t } = useI18n();
  const toast = useToast();
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("library");
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerPanel, setManagerPanel] = useState<ManagerPanel>("library");
  const openManager = (panel: ManagerPanel) => {
    setManagerPanel(panel);
    setManagerOpen(true);
  };
  const [tray, setTray] = useState<ImageRow[]>([]);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"library" | "remote">("library");
  const { remote, conn, reportNetworkError } = useRemote();
  const [showAddHistory, setShowAddHistory] = useState(false);
  // Bumped by panels whose item totals change without a data refresh (drafts).
  const [countsVersion, setCountsVersion] = useState(0);
  const bumpCounts = useCallback(() => setCountsVersion((v) => v + 1), []);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [queue, setQueue] = useState<QueueTask[]>([]);
  const [concurrency, setConcurrency] = useState(initialConcurrency);
  const [undoSeconds, setUndoSeconds] = useState(initialUndoSeconds);
  // Bumped once when the earliest undo-send countdown elapses, so the
  // processor re-evaluates exactly then. The visible per-card countdown ticks
  // locally inside QueueItem — App must not re-render 4×/sec for it.
  const [dispatchTick, setDispatchTick] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const isPhone = useIsPhone();
  const [phoneTab, setPhoneTab] = useState<PhoneTab>(initialPhoneTab);
  const [morePage, setMorePage] = useState<MorePage | null>(null);
  // Library's select mode is internal; the phone shell hides the tab bar while
  // it is on so Library can show the floating selection capsule instead.
  const [phoneSelecting, setPhoneSelecting] = useState(false);
  // Image viewer (lightbox) + a bump counter to refresh data after tag edits.
  const [viewer, setViewer] = useState<{ image: ImageRow; list: ImageRow[] } | null>(
    null,
  );
  const [dataVersion, setDataVersion] = useState(0);
  const [draftVersion, setDraftVersion] = useState(0);
  const openViewer = useCallback(
    (image: ImageRow, list: ImageRow[] = []) => setViewer({ image, list }),
    [],
  );
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  // Back from a dropped link: results the Mac finished meanwhile are already in
  // History, so reload the panels.
  const prevConn = useRef(conn);
  useEffect(() => {
    if (prevConn.current === "lost" && conn === "ok") bumpData();
    prevConn.current = conn;
  }, [conn, bumpData]);
  const consumePrefill = useCallback(() => setPrefill(null), []);

  const refreshConfig = () =>
    api.getVertex().then((r) => setConfigured(r.configured));

  useEffect(() => {
    refreshConfig();
  }, []);

  // Drag guard. A file dropped where nothing takes it would make the webview
  // navigate to that file and lose the composer, so unhandled file drags are
  // refused here (targets call preventDefault first). Plain <img> drags are
  // cancelled too: library images drag as rows (imageDrag.ts), not files.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      if (e.target instanceof HTMLImageElement) e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !isRefDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const onDrop = (e: DragEvent) => {
      if (isRefDrag(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // The Tauri shell dispatches this after a download finishes. Browsers never
  // send it, so the same frontend works there without any Tauri JS.
  useEffect(() => {
    const onDownload = (event: Event) => {
      const detail = (event as CustomEvent<{ ok?: boolean; name?: string }>).detail;
      if (!detail || typeof detail.name !== "string" || !detail.name) return;
      const ok = detail.ok === true;
      toast(ok ? t("download_done", { name: detail.name }) : t("download_failed", { name: detail.name }), ok ? "success" : "error");
    };
    window.addEventListener("imagen:download", onDownload);
    return () => window.removeEventListener("imagen:download", onDownload);
  }, [t, toast]);

  useEffect(() => {
    if (!resizingSidebar) return;

    const onPointerMove = (e: PointerEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = Math.min(
        rect.width * SIDEBAR_MAX_RATIO,
        Math.max(MIN_SIDEBAR_WIDTH, e.clientX - rect.left),
      );
      setSidebarWidth(next);
    };
    const onPointerUp = () => {
      setResizingSidebar(false);
    };

    document.body.classList.add("resizing-sidebar");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizingSidebar]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(PHONE_TAB_KEY, phoneTab);
  }, [phoneTab]);

  const changePhoneTab = useCallback((tab: PhoneTab) => {
    setPhoneTab(tab);
    // Leaving "more" returns its next visit to the list, not the last subpage.
    if (tab !== "more") setMorePage(null);
  }, []);

  // Clamp sidebar width on mount and window resize so it never exceeds 70%.
  useLayoutEffect(() => {
    const clamp = () => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxWidth = rect.width * SIDEBAR_MAX_RATIO;
      setSidebarWidth((prev) =>
        Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, prev)),
      );
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  useEffect(() => {
    localStorage.setItem(CONCURRENCY_KEY, String(concurrency));
  }, [concurrency]);

  useEffect(() => {
    localStorage.setItem(UNDO_SECONDS_KEY, String(undoSeconds));
  }, [undoSeconds]);

  // Poll live backend phase (sent / retrying) for in-flight tasks — including
  // "cancelling", whose request is still open. Keyed by the set of ids so the
  // interval is stable across phase updates.
  const runningKey = queue
    .filter((t) => t.status === "running" || t.status === "cancelling")
    .map((t) => t.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!runningKey) return;
    const ids = runningKey.split(",");
    const poll = async () => {
      const got = await Promise.all(
        ids.map(async (id) => [id, await api.getProgress(id)] as const),
      );
      setQueue((q) =>
        q.map((t) => {
          const hit = got.find(([id]) => id === t.id);
          return hit && (t.status === "running" || t.status === "cancelling")
            ? { ...t, phase: hit[1] }
            : t;
        }),
      );
    };
    const id = setInterval(poll, 3000);
    poll();
    return () => clearInterval(id);
  }, [runningKey]);

  // Wake the processor exactly when the earliest undo-send countdown elapses
  // (a one-shot timeout — not a 250ms tick, which would re-render the whole
  // app tree). dispatchTick is a dep so a too-early wake reschedules itself.
  useEffect(() => {
    const waits = queue
      .filter((t) => t.status === "pending" && t.dispatchAt > Date.now())
      .map((t) => t.dispatchAt);
    if (waits.length === 0) return;
    const delay = Math.max(0, Math.min(...waits) - Date.now()) + 20;
    const id = setTimeout(() => setDispatchTick((v) => v + 1), delay);
    return () => clearTimeout(id);
  }, [queue, dispatchTick]);

  // --- Generation queue (lives in App so it survives tab switches) ---
  // Enqueue a task `count` times as one retry group: the first copy keeps the
  // composer's own auto-skip setting, every later copy is opted in, so the first
  // success cancels the remaining retries of *this* task only.
  const enqueue = useCallback(
    (task: TaskSpec, count = 1) => {
      const n = Math.max(1, Math.min(MAX_TASK_ATTEMPTS, Math.floor(count) || 1));
      setQueue((q) => {
        const dispatchAt = Date.now() + undoSeconds * 1000;
        const added: QueueTask[] = Array.from({ length: n }, (_, i) => ({
          ...task,
          skipIfPrecedingSucceeds:
            i === 0 ? task.skipIfPrecedingSucceeds : true,
          id: uuid(),
          status: "pending",
          dispatchAt,
        }));
        return [...q, ...added];
      });
    },
    [undoSeconds],
  );

  // In-flight or cancelling tasks must not be removed by the × / clear-done.
  const isActive = (s: QueueTask["status"]) =>
    s === "running" || s === "cancelling";

  // Latest queue snapshot for stable event handlers (abortTask), so QueueItem
  // can be memoized without its callbacks changing on every queue update.
  const queueRef = useRef<QueueTask[]>(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Guards double-dispatch; entries are pruned when a task settles or leaves
  // the queue so the set doesn't grow for the life of the session.
  const startedRef = useRef<Set<string>>(new Set());

  const removeTask = useCallback((id: string) => {
    setQueue((q) => q.filter((t) => !(t.id === id && !isActive(t.status))));
    startedRef.current.delete(id);
  }, []);

  // Cancel a task. Pending → just drop it (never sent, never billed). Running →
  // send a cancel signal and show "cancelling": the request stays open, the
  // backend finishes the current in-flight attempt (keeping a completed result)
  // then stops retrying, and its real final result (aborted, or success saved to
  // the library) updates the card via the original request's .then.
  const abortTask = useCallback(
    (id: string) => {
      const task = queueRef.current.find((t) => t.id === id);
      if (task && isActive(task.status)) {
        api.cancelGenerate(id).catch(() => {});
        setQueue((q) =>
          q.map((t) => (t.id === id ? { ...t, status: "cancelling" } : t)),
        );
      } else {
        removeTask(id);
      }
    },
    [removeTask],
  );

  const clearDone = useCallback(() => {
    setQueue((q) => {
      const kept = q.filter((t) => t.status === "pending" || isActive(t.status));
      const keptIds = new Set(kept.map((t) => t.id));
      for (const id of startedRef.current) {
        if (!keptIds.has(id)) startedRef.current.delete(id);
      }
      return kept;
    });
  }, []);

  // Bounded FIFO processor: dispatch tasks whose undo-send window has elapsed,
  // up to the user-chosen concurrency, without flooding Vertex.
  useEffect(() => {
    // Alias so the i18n `t` is reachable inside queue .map callbacks that
    // shadow it with a `t` task parameter.
    const translate = t;
    // A cancelling task still holds an open request → keep counting its slot.
    const running = queue.filter((t) => isActive(t.status)).length;
    const slots = concurrency - running;
    if (slots <= 0) return;
    // Remote device with the Mac unreachable: hold the queue until it's back.
    if (remote && conn === "lost") return;

    const nextTasks = queue
      .filter(
        (t) =>
          t.status === "pending" &&
          !startedRef.current.has(t.id) &&
          t.dispatchAt <= Date.now(),
      )
      .slice(0, slots);
    if (nextTasks.length === 0) return;

    nextTasks.forEach((task) => startedRef.current.add(task.id));
    const nextIds = new Set(nextTasks.map((task) => task.id));
    setQueue((q) =>
      q.map((t) => (nextIds.has(t.id) ? { ...t, status: "running" } : t)),
    );

    nextTasks.forEach((task) => {
      api
        .generate({
          prompt: task.prompt,
          model: task.model,
          aspectRatio: task.aspectRatio,
          resolution: task.resolution,
          outputFormat: task.format,
          inputImageIds: task.inputs.map((i) => i.id),
          uploadImageIds: [],
          tagIds: task.tagIds,
          clientTaskId: task.id,
          markerColor: task.markerColor,
        })
        // The original request stays open through cancellation, so its result
        // (success / aborted / blocked / error) is the true final state and
        // overwrites a "cancelling" placeholder.
        .then((res) => {
          startedRef.current.delete(task.id);
          setQueue((q) => {
            const afterSelf: QueueTask[] = q.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    status: res.status,
                    message: res.message,
                    text: res.text,
                    rawFinish: res.generation?.raw_finish,
                    outputImage: res.outputImage,
                  } as QueueTask
                : t,
            );
            // "Retry until one succeeds" is scoped to a group: a non-opted-in
            // task plus the consecutive opted-in tasks right after it. On a
            // successful outcome, skip only the still-pending opted-in tasks
            // in the succeeded task's own group — later groups are independent
            // retries of a different job. On any non-success outcome
            // (blocked/error) we leave those tasks untouched so a later success
            // can still skip them.
            if (res.status === "success") {
              const idx = afterSelf.findIndex((t) => t.id === task.id);
              if (idx === -1) return afterSelf;
              let start = idx;
              while (start > 0 && afterSelf[start].skipIfPrecedingSucceeds)
                start -= 1;
              let end = idx;
              while (
                end + 1 < afterSelf.length &&
                afterSelf[end + 1].skipIfPrecedingSucceeds
              )
                end += 1;
              return afterSelf.map((t, i) =>
                i >= start &&
                i <= end &&
                t.status === "pending" &&
                t.skipIfPrecedingSucceeds
                  ? {
                      ...t,
                      status: "aborted" as const,
                      message: translate("skipped_by_preceding_success"),
                    } as QueueTask
                  : t,
              );
            }
            return afterSelf;
          });
        })
        .catch((err) => {
          // A thrown error is a non-success outcome: mark this task failed and
          // leave still-pending opted-in tasks alone so a later success can
          // still skip them.
          startedRef.current.delete(task.id);
          // fetch() rejects with a TypeError when the link drops. On a remote
          // device the Mac may still be generating, so say so instead of failing.
          const interrupted = remote && (err instanceof TypeError || err instanceof SyntaxError);
          if (interrupted) reportNetworkError();
          setQueue((q) =>
            q.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    status: "error" as const,
                    interrupted,
                    message: interrupted ? translate("remote_interrupted_msg") : (err as Error).message,
                  } as QueueTask
                : t,
            ),
          );
        });
    });
  }, [queue, dispatchTick, concurrency, remote, conn, reportNetworkError]);

  const addToTray = useCallback(
    (img: ImageRow) =>
      setTray((t) => (t.some((x) => x.id === img.id) ? t : [...t, img])),
    [],
  );
  const addManyToTray = useCallback(
    (imgs: ImageRow[]) =>
      setTray((t) => {
        const seen = new Set(t.map((x) => x.id));
        return [...t, ...imgs.filter((i) => !seen.has(i.id))];
      }),
    [],
  );
  const removeFromTray = useCallback(
    (id: number) => setTray((t) => t.filter((x) => x.id !== id)),
    [],
  );
  const moveInTray = useCallback(
    (from: number, to: number) =>
      setTray((t) => {
        const next = [...t];
        const [m] = next.splice(from, 1);
        next.splice(to, 0, m);
        return next;
      }),
    [],
  );

  const reuse = useCallback((g: Generation) => {
    setTray(g.inputs ?? []);
    setPrefill({
      prompt: g.prompt,
      model: g.model,
      aspectRatio: g.aspect_ratio,
      resolution: g.resolution,
    });
  }, []);

  // Reuse a queued task's settings (prompt/model/ratio/resolution + inputs).
  const reuseTask = useCallback((task: QueueTask) => {
    setTray(task.inputs ?? []);
    setPrefill({
      prompt: task.prompt,
      model: task.model,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
    });
  }, []);

  // Reuse a queued task's settings AND enqueue it immediately (skip the form).
  const reuseGenerateTask = useCallback(
    (task: QueueTask) =>
      enqueue({
        prompt: task.prompt,
        model: task.model,
        aspectRatio: task.aspectRatio,
        resolution: task.resolution,
        format: task.format,
        inputs: task.inputs,
        outputImages: task.outputImages ?? [],
        tagIds: task.tagIds,
        skipIfPrecedingSucceeds: task.skipIfPrecedingSucceeds,
      }),
    [enqueue],
  );

  // Re-run a history record as-is (its live inputs, default format/no tags).
  const rerunGeneration = useCallback(
    (g: Generation) =>
      enqueue({
        prompt: g.prompt,
        model: g.model,
        aspectRatio: g.aspect_ratio ?? "1:1",
        resolution: g.resolution,
        format: "image/jpeg",
        inputs: (g.inputs ?? []).filter((im) => !im.deleted_at),
        tagIds: [],
      }),
    [enqueue],
  );

  const taskToDraftBody = useCallback((task: TaskSpec): DraftBody => ({
    prompt: task.prompt,
    model: task.model,
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    outputFormat: task.format,
    skipIfPrecedingSucceeds: !!task.skipIfPrecedingSucceeds,
    inputImageIds: task.inputs.map((img) => img.id),
    outputImageIds: (task.outputImages ?? []).map((img) => img.id),
    tagIds: task.tagIds,
  }), []);

  const saveTaskAsDraft = useCallback(async (task: TaskSpec) => {
    try {
      await api.createDraft(taskToDraftBody(task));
      setDraftVersion((v) => v + 1);
      toast(t("draft_saved"));
      return true;
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
      return false;
    }
  }, [t, taskToDraftBody, toast]);

  const saveQueueTaskAsDraft = useCallback(async (task: QueueTask, move: boolean) => {
    const saved = await saveTaskAsDraft(task);
    if (saved && move && task.status === "pending") removeTask(task.id);
  }, [removeTask, saveTaskAsDraft]);

  const setTaskMarker = useCallback((id: string, markerColor: MarkerColor | null) => {
    const task = queueRef.current.find((item) => item.id === id);
    setQueue((q) => q.map((item) => item.id === id ? { ...item, markerColor } : item));
    if (!task || task.status === "pending") return;
    // The running History placeholder is created just after dispatch. A very
    // fast marker click can beat that INSERT, so retry once after it settles.
    api.updateGenerationMarker(id, markerColor).catch(() => {
      window.setTimeout(() => api.updateGenerationMarker(id, markerColor).catch(() => {}), 1000);
    });
  }, []);

  const completedRefreshKey =
    queue.filter((task) => task.status !== "pending" && task.status !== "running")
      .length + dataVersion;

  const counts = usePanelCounts(
    `${completedRefreshKey}:${draftVersion}:${countsVersion}:${sidebarPanel}`,
  );

  const phoneActiveCount = queue.filter(
    (task) =>
      task.status === "pending" ||
      task.status === "running" ||
      task.status === "cancelling",
  ).length;

  return (
    <>
      {!isPhone && (
      <div
        className={`app-shell${remote ? " remote" : ""}`}
        ref={workspaceRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="side-panel">
          <div className="side-tabs-row">
            <div className="side-brand">
              <img className="brand-icon" src={appIcon} alt="" />
              <span className="side-brand-name">Imagen</span>
            </div>
            <PanelTabs
              value={sidebarPanel}
              onChange={setSidebarPanel}
              tabs={[
                { id: "library", label: t("tab_library"), icon: "library", count: counts.library },
                { id: "history", label: t("tab_history"), icon: "history", count: counts.history },
                { id: "favorites", label: t("tab_favorites"), icon: "favorite", count: counts.favorites },
                { id: "drafts", label: t("tab_drafts"), icon: "drafts", count: counts.drafts },
              ]}
            />
            <IconButton
              className="side-expand"
              variant="outline"
              size="md"
              icon="bin"
              label={counts.bin ? `${t("bin_title")} (${counts.bin})` : t("bin_title")}
              onClick={() => openManager("bin")}
            />
            <IconButton
              className="side-expand"
              variant="outline"
              size="md"
              icon="fullscreen"
              label={t("fullscreen_manage")}
              onClick={() => openManager(sidebarPanel)}
            />
          </div>
          <div className="side-scroll">
            {sidebarPanel === "library" ? (
              <Library
                addToTray={addToTray}
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
                onChanged={bumpData}
              />
            ) : sidebarPanel === "history" ? (
              <History
                onReuse={reuse}
                onRerun={configured ? rerunGeneration : undefined}
                onUseAsRef={addToTray}
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
                live={runningKey !== ""}
              />
            ) : sidebarPanel === "favorites" ? (
              <Favorites
                onReuse={reuse}
                onRerun={configured ? rerunGeneration : undefined}
                onUseAsRef={addToTray}
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
                onChanged={bumpData}
              />
            ) : (
              <Drafts
                compact
                onChanged={bumpCounts}
                refreshKey={draftVersion}
                canQueue={!!configured}
                onQueue={enqueue}
                onOpenViewer={openViewer}
              />
            )}
          </div>
          <div
            className="resize-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("resize_sidebar")}
            aria-valuenow={Math.round(sidebarWidth)}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={Math.round(window.innerWidth * SIDEBAR_MAX_RATIO)}
            title={t("resize_sidebar")}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setResizingSidebar(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Home") {
                e.preventDefault();
                setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
                return;
              }
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              const rect = workspaceRef.current?.getBoundingClientRect();
              if (!rect) return;
              e.preventDefault();
              const step = e.shiftKey ? 64 : 16;
              const delta = e.key === "ArrowLeft" ? -step : step;
              setSidebarWidth((prev) =>
                Math.min(
                  rect.width * SIDEBAR_MAX_RATIO,
                  Math.max(MIN_SIDEBAR_WIDTH, prev + delta),
                ),
              );
            }}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        </aside>

        {remote && <div className={`rm-topline${conn === "lost" ? " lost" : ""}`} aria-hidden="true" />}
        <div className="main-col">
          <header className="topbar">
            <div className="spacer" />
            {remote ? (
              <RemoteChip />
            ) : (
              <RemoteIndicator
                onOpenSettings={() => {
                  setSettingsSection("remote");
                  setShowSettings(true);
                }}
              />
            )}
            <Button
              className="topbar-btn"
              icon="add"
              title={t("import_result")}
              onClick={() => setShowAddHistory(true)}
            >
              {t("new_menu")}
            </Button>
            <button className="topbar-btn" onClick={() => setDashboardOpen(true)} title={t("usage_title")}>
              <Icon name="usage" /> {t("usage")}
            </button>
            <button className="topbar-btn" onClick={() => { setSettingsSection("library"); setShowSettings(true); }}>
              {configured ? (
                <><Icon name="settings" /> {t("settings")}</>
              ) : (
                <><Icon name="warning" /> {t("set_api_key")}</>
              )}
            </button>
          </header>
          <main className="main-panel">
            {configured === false && (
              <div className="panel notice error">{t("no_key_warning")}</div>
            )}
            <Generate
              tray={tray}
              prefill={prefill}
              consumePrefill={consumePrefill}
              addManyToTray={addManyToTray}
              removeFromTray={removeFromTray}
              moveInTray={moveInTray}
              keyConfigured={!!configured}
              queue={queue}
              enqueue={enqueue}
              onSaveDraft={saveTaskAsDraft}
              removeTask={removeTask}
              abortTask={abortTask}
              clearDone={clearDone}
              onReuseTask={reuseTask}
              onReuseGenerateTask={reuseGenerateTask}
              onSaveQueueTaskAsDraft={saveQueueTaskAsDraft}
              onSetTaskMarker={setTaskMarker}
              onOpenViewer={openViewer}
              concurrency={concurrency}
              setConcurrency={setConcurrency}
              maxConcurrency={MAX_CONCURRENCY}
            />
          </main>
        </div>
      </div>
      )}

      {isPhone && (
        <div className={`app-shell phone-shell${remote ? " remote" : ""}`}>
          {remote && (
            <div className={`rm-topline${conn === "lost" ? " lost" : ""}`} aria-hidden="true" />
          )}
          <div className="phone-stage">
            <div className="phone-panel" hidden={phoneTab !== "library"}>
              <section className="side-panel phone-island">
                <div className="side-scroll phone-island-scroll">
                  <Library
                    addToTray={addToTray}
                    compact
                    phone
                    onSelectModeChange={setPhoneSelecting}
                    refreshKey={completedRefreshKey}
                    onOpenViewer={openViewer}
                    onChanged={bumpData}
                  />
                </div>
              </section>
            </div>

            <div className="phone-panel" hidden={phoneTab !== "history"}>
              <section className="side-panel phone-island">
                <div className="side-scroll phone-island-scroll">
                  <History
                    onReuse={reuse}
                    onRerun={configured ? rerunGeneration : undefined}
                    onUseAsRef={addToTray}
                    compact
                    phone
                    refreshKey={completedRefreshKey}
                    onOpenViewer={openViewer}
                    live={runningKey !== ""}
                  />
                </div>
              </section>
            </div>

            <div className="phone-panel" hidden={phoneTab !== "create"}>
              <Generate
                tray={tray}
                prefill={prefill}
                consumePrefill={consumePrefill}
                addManyToTray={addManyToTray}
                removeFromTray={removeFromTray}
                moveInTray={moveInTray}
                keyConfigured={!!configured}
                queue={queue}
                enqueue={enqueue}
                onSaveDraft={saveTaskAsDraft}
                removeTask={removeTask}
                abortTask={abortTask}
                clearDone={clearDone}
                onReuseTask={reuseTask}
                onReuseGenerateTask={reuseGenerateTask}
                onSaveQueueTaskAsDraft={saveQueueTaskAsDraft}
                onSetTaskMarker={setTaskMarker}
                onOpenViewer={openViewer}
                concurrency={concurrency}
                setConcurrency={setConcurrency}
                maxConcurrency={MAX_CONCURRENCY}
                phone
              />
            </div>

            <div className="phone-panel" hidden={phoneTab !== "more"}>
              {morePage ? (
                <section className="side-panel phone-island">
                  <header className="phone-head phone-subhead">
                    <IconButton
                      icon="prev"
                      label={t("phone_back")}
                      onClick={() => setMorePage(null)}
                    />
                    <h1>
                      {morePage === "favorites"
                        ? t("tab_favorites")
                        : morePage === "drafts"
                          ? t("tab_drafts")
                          : t("tab_bin")}
                    </h1>
                  </header>
                  <div className="side-scroll phone-island-scroll">
                    {morePage === "favorites" ? (
                      <Favorites
                        onReuse={reuse}
                        onRerun={configured ? rerunGeneration : undefined}
                        onUseAsRef={addToTray}
                        compact
                        phone
                        refreshKey={completedRefreshKey}
                        onOpenViewer={openViewer}
                        onChanged={bumpData}
                      />
                    ) : morePage === "drafts" ? (
                      <Drafts
                        compact
                        phone
                        onChanged={bumpCounts}
                        refreshKey={draftVersion}
                        canQueue={!!configured}
                        onQueue={enqueue}
                        onOpenViewer={openViewer}
                      />
                    ) : (
                      <Bin
                        onOpenViewer={openViewer}
                        refreshKey={completedRefreshKey}
                        onChanged={bumpData}
                      />
                    )}
                  </div>
                </section>
              ) : (
                <MoreMenu
                  counts={counts}
                  onOpenPage={setMorePage}
                  onOpenUsage={() => setDashboardOpen(true)}
                  onOpenSettings={() => {
                    setSettingsSection("library");
                    setShowSettings(true);
                  }}
                />
              )}
            </div>
          </div>

          {!phoneSelecting && (
            <PhoneTabBar
              value={phoneTab}
              onChange={changePhoneTab}
              badge={phoneActiveCount}
            />
          )}
        </div>
      )}

      {showSettings && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setShowSettings(false)}
          onSaved={refreshConfig}
          undoSeconds={undoSeconds}
          setUndoSeconds={setUndoSeconds}
        />
      )}

      {showAddHistory && (
        <AddHistoryModal
          onClose={() => setShowAddHistory(false)}
          onSaved={bumpData}
        />
      )}

      {managerOpen && (
        <FullscreenManager
          counts={counts}
          onCountsChanged={bumpCounts}
          initialPanel={managerPanel}
          onClose={() => setManagerOpen(false)}
          addToTray={addToTray}
          onOpenViewer={openViewer}
          onReuse={reuse}
          onRerun={configured ? rerunGeneration : undefined}
          refreshKey={completedRefreshKey}
          onChanged={bumpData}
          draftRefreshKey={draftVersion}
          canQueue={!!configured}
          onQueueDraft={enqueue}
          historyLive={runningKey !== ""}
        />
      )}

      {dashboardOpen && (
        <UsageDashboard onClose={() => setDashboardOpen(false)} />
      )}

      <HoverPeek />

      {viewer && (
        <ImageViewer
          image={viewer.image}
          list={viewer.list}
          onClose={() => setViewer(null)}
          onAddToTray={addToTray}
          onTagsChanged={bumpData}
          onReuse={reuse}
          onChanged={bumpData}
        />
      )}
    </>
  );
}
