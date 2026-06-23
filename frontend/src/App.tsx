import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ImageRow, Generation, QueueTask } from "./api";
import { useI18n } from "./i18n";
import Generate from "./pages/Generate";
import Library from "./pages/Library";
import History from "./pages/History";
import Favorites from "./pages/Favorites";
import SettingsModal from "./components/SettingsModal";
import AddHistoryModal from "./components/AddHistoryModal";
import UsageDashboard from "./components/UsageDashboard";
import ImageViewer from "./components/ImageViewer";
import FullscreenManager, { type ManagerPanel } from "./components/FullscreenManager";

export type SidebarPanel = "library" | "history" | "favorites";

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
const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 260;
const SIDEBAR_MAX_RATIO = 0.7;

function initialSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved)
    ? Math.max(MIN_SIDEBAR_WIDTH, saved)
    : DEFAULT_SIDEBAR_WIDTH;
}

function initialConcurrency() {
  const v = Number(localStorage.getItem(CONCURRENCY_KEY));
  return Number.isInteger(v) && v >= 1 && v <= MAX_CONCURRENCY
    ? v
    : DEFAULT_CONCURRENCY;
}

function initialUndoSeconds() {
  const v = Number(localStorage.getItem(UNDO_SECONDS_KEY));
  return Number.isFinite(v) && v >= 0 && v <= 60 ? v : DEFAULT_UNDO_SECONDS;
}

export default function App() {
  const { t, lang, setLang } = useI18n();
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
  const [showAddHistory, setShowAddHistory] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [queue, setQueue] = useState<QueueTask[]>([]);
  const [concurrency, setConcurrency] = useState(initialConcurrency);
  const [undoSeconds, setUndoSeconds] = useState(initialUndoSeconds);
  // Ticks while any task is still in its undo-send countdown, so the countdown
  // re-renders and the processor re-evaluates when a task becomes dispatchable.
  const [now, setNow] = useState(() => Date.now());
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Image viewer (lightbox) + a bump counter to refresh data after tag edits.
  const [viewer, setViewer] = useState<{ image: ImageRow; list: ImageRow[] } | null>(
    null,
  );
  const [dataVersion, setDataVersion] = useState(0);
  const openViewer = (image: ImageRow, list: ImageRow[] = []) =>
    setViewer({ image, list });
  const bumpData = () => setDataVersion((v) => v + 1);

  const refreshConfig = () =>
    api.getVertex().then((r) => setConfigured(r.configured));

  useEffect(() => {
    refreshConfig();
  }, []);

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

  // Poll live backend phase (sent / retrying) for running tasks. Keyed by the
  // set of running ids so the interval is stable across phase updates.
  const runningKey = queue
    .filter((t) => t.status === "running")
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
          return hit && t.status === "running" ? { ...t, phase: hit[1] } : t;
        }),
      );
    };
    const id = setInterval(poll, 1200);
    poll();
    return () => clearInterval(id);
  }, [runningKey]);

  // Drive the countdown clock only while a task is still waiting to be sent.
  useEffect(() => {
    const hasCountdown = queue.some(
      (t) => t.status === "pending" && t.dispatchAt > Date.now(),
    );
    if (!hasCountdown) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [queue]);

  // --- Generation queue (lives in App so it survives tab switches) ---
  const enqueue = (task: Omit<QueueTask, "id" | "status" | "dispatchAt">) =>
    setQueue((q) => [
      ...q,
      {
        ...task,
        id: crypto.randomUUID(),
        status: "pending",
        dispatchAt: Date.now() + undoSeconds * 1000,
      },
    ]);

  // In-flight or cancelling tasks must not be removed by the × / clear-done.
  const isActive = (s: QueueTask["status"]) =>
    s === "running" || s === "cancelling";

  const removeTask = (id: string) =>
    setQueue((q) => q.filter((t) => !(t.id === id && !isActive(t.status))));

  // Cancel a task. Pending → just drop it (never sent, never billed). Running →
  // send a cancel signal and show "cancelling": the request stays open, the
  // backend finishes the current in-flight attempt (keeping a completed result)
  // then stops retrying, and its real final result (aborted, or success saved to
  // the library) updates the card via the original request's .then.
  const abortTask = (id: string) => {
    const task = queue.find((t) => t.id === id);
    if (task && isActive(task.status)) {
      api.cancelGenerate(id).catch(() => {});
      setQueue((q) =>
        q.map((t) => (t.id === id ? { ...t, status: "cancelling" } : t)),
      );
    } else {
      removeTask(id);
    }
  };

  const clearDone = () =>
    setQueue((q) => q.filter((t) => t.status === "pending" || isActive(t.status)));

  // Bounded FIFO processor: dispatch tasks whose undo-send window has elapsed,
  // up to the user-chosen concurrency, without flooding Vertex.
  const startedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A cancelling task still holds an open request → keep counting its slot.
    const running = queue.filter((t) => isActive(t.status)).length;
    const slots = concurrency - running;
    if (slots <= 0) return;

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
        })
        // The original request stays open through cancellation, so its result
        // (success / aborted / blocked / error) is the true final state and
        // overwrites a "cancelling" placeholder.
        .then((res) =>
          setQueue((q) =>
            q.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    status: res.status,
                    message: res.message,
                    text: res.text,
                    rawFinish: res.generation?.raw_finish,
                    outputImage: res.outputImage,
                  }
                : t,
            ),
          ),
        )
        .catch((err) =>
          setQueue((q) =>
            q.map((t) =>
              t.id === task.id
                ? { ...t, status: "error", message: (err as Error).message }
                : t,
            ),
          ),
        );
    });
  }, [queue, now, concurrency]);

  const addToTray = (img: ImageRow) =>
    setTray((t) => (t.some((x) => x.id === img.id) ? t : [...t, img]));
  const addManyToTray = (imgs: ImageRow[]) =>
    setTray((t) => {
      const seen = new Set(t.map((x) => x.id));
      return [...t, ...imgs.filter((i) => !seen.has(i.id))];
    });
  const removeFromTray = (id: number) =>
    setTray((t) => t.filter((x) => x.id !== id));
  const moveInTray = (from: number, to: number) =>
    setTray((t) => {
      const next = [...t];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });

  const reuse = (g: Generation) => {
    setTray(g.inputs ?? []);
    setPrefill({
      prompt: g.prompt,
      model: g.model,
      aspectRatio: g.aspect_ratio,
      resolution: g.resolution,
    });
  };

  // Reuse a queued task's settings (prompt/model/ratio/resolution + inputs).
  const reuseTask = (task: QueueTask) => {
    setTray(task.inputs ?? []);
    setPrefill({
      prompt: task.prompt,
      model: task.model,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
    });
  };

  // Reuse a queued task's settings AND enqueue it immediately (skip the form).
  // enqueue expects Omit<QueueTask, "id"|"status"|"dispatchAt">; QueueTask already
  // carries every field, so spreading is a direct, lossless match.
  const reuseGenerateTask = (task: QueueTask) =>
    enqueue({
      prompt: task.prompt,
      model: task.model,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
      format: task.format,
      inputs: task.inputs,
      tagIds: task.tagIds,
    });

  const completedRefreshKey =
    queue.filter((task) => task.status !== "pending" && task.status !== "running")
      .length + dataVersion;

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="banana">🍌</span> Imagen
          </div>
          <div className="spacer" />
          <button
            className="lang-toggle"
            title="Language"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {lang === "zh" ? "EN" : "ZH"}
          </button>
          <button className="topbar-btn" onClick={() => setShowAddHistory(true)} title={t("add_history_title")}>
            <i className="fa-solid fa-square-plus"></i> {t("add_history")}
          </button>
          <button className="topbar-btn" onClick={() => setDashboardOpen(true)} title={t("usage_title")}>
            <i className="fa-solid fa-chart-simple"></i> {t("usage")}
          </button>
          <button className="topbar-btn" onClick={() => setShowSettings(true)}>
            {configured ? (
              <><i className="fa-solid fa-gear"></i> {t("settings")}</>
            ) : (
              <><i className="fa-solid fa-triangle-exclamation"></i> {t("set_api_key")}</>
            )}
          </button>
        </div>
      </div>

      <div className="app workspace"
        ref={workspaceRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="side-panel">
          <div className="side-tabs-row">
            <div className="side-tabs">
              {(
                [
                  ["library", "fa-images"],
                  ["history", "fa-clock-rotate-left"],
                  ["favorites", "fa-star"],
                ] as [SidebarPanel, string][]
              ).map(([panel, icon]) => (
                <button
                  key={panel}
                  className={`tab${sidebarPanel === panel ? " active" : ""}`}
                  title={t(`tab_${panel}`)}
                  onClick={() => setSidebarPanel(panel)}
                >
                  <i className={`fa-solid ${icon}`} />
                </button>
              ))}
            </div>
            <button
              className="side-expand"
              title={t("bin_title")}
              onClick={() => openManager("bin")}
            >
              <i className="fa-solid fa-trash-can" />
            </button>
            <button
              className="side-expand"
              title={t("fullscreen_manage")}
              onClick={() => openManager(sidebarPanel)}
            >
              <i className="fa-solid fa-expand" />
            </button>
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
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
              />
            ) : (
              <Favorites
                onReuse={reuse}
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
                onChanged={bumpData}
              />
            )}
          </div>
        </aside>

        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("resize_sidebar")}
          title={t("resize_sidebar")}
          onPointerDown={(e) => {
            e.preventDefault();
            setResizingSidebar(true);
          }}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        />

        <main className="main-panel">
          {configured === false && (
            <div className="panel notice error">{t("no_key_warning")}</div>
          )}
          <Generate
            tray={tray}
            prefill={prefill}
            consumePrefill={() => setPrefill(null)}
            addManyToTray={addManyToTray}
            removeFromTray={removeFromTray}
            moveInTray={moveInTray}
            keyConfigured={!!configured}
            queue={queue}
            enqueue={enqueue}
            removeTask={removeTask}
            abortTask={abortTask}
            clearDone={clearDone}
            onReuseTask={reuseTask}
            onReuseGenerateTask={reuseGenerateTask}
            onOpenViewer={openViewer}
            now={now}
            concurrency={concurrency}
            setConcurrency={setConcurrency}
            maxConcurrency={MAX_CONCURRENCY}
          />
        </main>
      </div>

      {showSettings && (
        <SettingsModal
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
          initialPanel={managerPanel}
          onClose={() => setManagerOpen(false)}
          addToTray={addToTray}
          onOpenViewer={openViewer}
          onReuse={reuse}
          refreshKey={completedRefreshKey}
          onChanged={bumpData}
        />
      )}

      {dashboardOpen && (
        <UsageDashboard onClose={() => setDashboardOpen(false)} />
      )}

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
