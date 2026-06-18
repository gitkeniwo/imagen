import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, ImageRow, Generation, QueueTask } from "./api";
import { useI18n } from "./i18n";
import Generate from "./pages/Generate";
import Library from "./pages/Library";
import History from "./pages/History";
import SettingsModal from "./components/SettingsModal";
import ImageViewer from "./components/ImageViewer";
import FullscreenManager from "./components/FullscreenManager";

export type SidebarPanel = "library" | "history";

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
const MAX_SIDEBAR_WIDTH = 620;

function initialSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved))
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
  const [tray, setTray] = useState<ImageRow[]>([]);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
      const workspaceLeft =
        workspaceRef.current?.getBoundingClientRect().left ?? 20;
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, e.clientX - workspaceLeft),
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
    localStorage.setItem(CONCURRENCY_KEY, String(concurrency));
  }, [concurrency]);

  useEffect(() => {
    localStorage.setItem(UNDO_SECONDS_KEY, String(undoSeconds));
  }, [undoSeconds]);

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
  // In-flight request controllers, so a running task can be aborted.
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

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

  const removeTask = (id: string) =>
    setQueue((q) => q.filter((t) => !(t.id === id && t.status !== "running")));

  // Cancel a task. Pending → just drop it (never sent, never billed). Running →
  // abort the in-flight request: stops the backend retry loop (real savings when
  // stuck on 429) and discards the result. NOTE: a generation Vertex already
  // finished may still be billed — disconnecting cannot un-charge it.
  const abortTask = (id: string) => {
    const task = queue.find((t) => t.id === id);
    if (task?.status === "running") {
      controllersRef.current.get(id)?.abort();
      controllersRef.current.delete(id);
      startedRef.current.delete(id);
      setQueue((q) =>
        q.map((t) => (t.id === id ? { ...t, status: "aborted", message: null } : t)),
      );
    } else {
      removeTask(id);
    }
  };

  const clearDone = () =>
    setQueue((q) =>
      q.filter((t) => t.status === "pending" || t.status === "running"),
    );

  // Bounded FIFO processor: dispatch tasks whose undo-send window has elapsed,
  // up to the user-chosen concurrency, without flooding Vertex.
  const startedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const running = queue.filter((t) => t.status === "running").length;
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
      const controller = new AbortController();
      controllersRef.current.set(task.id, controller);
      api
        .generate(
          {
            prompt: task.prompt,
            model: task.model,
            aspectRatio: task.aspectRatio,
            resolution: task.resolution,
            outputFormat: task.format,
            inputImageIds: task.inputs.map((i) => i.id),
            uploadImageIds: [],
            tagIds: task.tagIds,
          },
          controller.signal,
        )
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
        .catch((err) => {
          // User-initiated abort: status was already set to "aborted" by
          // abortTask — don't clobber it with an error.
          if ((err as Error).name === "AbortError") return;
          setQueue((q) =>
            q.map((t) =>
              t.id === task.id
                ? { ...t, status: "error", message: (err as Error).message }
                : t,
            ),
          );
        })
        .finally(() => controllersRef.current.delete(task.id));
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

  const completedRefreshKey =
    queue.filter((task) => task.status !== "pending" && task.status !== "running")
      .length + dataVersion;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="banana">🍌</span> Nano Banana Studio
        </div>
        <div className="spacer" />
        <button
          className="lang-toggle"
          title="中文 / English"
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        >
          {lang === "zh" ? "EN" : "中"}
        </button>
        <button onClick={() => setShowSettings(true)}>
          {configured ? `⚙ ${t("settings")}` : `⚠ ${t("set_api_key")}`}
        </button>
      </div>

      <div
        ref={workspaceRef}
        className="workspace"
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="side-panel">
          <div className="side-tabs-row">
            <div className="side-tabs">
              {(["library", "history"] as SidebarPanel[]).map((panel) => (
                <button
                  key={panel}
                  className={`tab${sidebarPanel === panel ? " active" : ""}`}
                  onClick={() => setSidebarPanel(panel)}
                >
                  {t(`tab_${panel}`)}
                </button>
              ))}
            </div>
            <button
              className="side-expand"
              title={t("fullscreen_manage")}
              onClick={() => setManagerOpen(true)}
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
              />
            ) : (
              <History
                onReuse={reuse}
                compact
                refreshKey={completedRefreshKey}
                onOpenViewer={openViewer}
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

      {managerOpen && (
        <FullscreenManager
          initialPanel={sidebarPanel}
          onClose={() => setManagerOpen(false)}
          addToTray={addToTray}
          onOpenViewer={openViewer}
          onReuse={reuse}
          refreshKey={completedRefreshKey}
        />
      )}

      {viewer && (
        <ImageViewer
          image={viewer.image}
          list={viewer.list}
          onClose={() => setViewer(null)}
          onAddToTray={addToTray}
          onTagsChanged={bumpData}
        />
      )}
    </div>
  );
}
