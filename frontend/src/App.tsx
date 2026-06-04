import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, ImageRow, Generation, QueueTask } from "./api";
import { useI18n } from "./i18n";
import Generate from "./pages/Generate";
import Library from "./pages/Library";
import History from "./pages/History";
import SettingsModal from "./components/SettingsModal";
import ImageViewer from "./components/ImageViewer";

export type SidebarPanel = "library" | "history";

export interface Prefill {
  prompt: string;
  model: string;
  aspectRatio: string | null;
  resolution: string | null;
}

// Keep this well under the browser's ~6 HTTP/1.1 connections-per-host limit.
// Each /api/generate is long-lived (server-side retry/backoff can hold it open
// for minutes), so too many in flight starve the connection pool and the whole
// UI (sidebar, thumbnails) stops loading. A small cap also cuts self-inflicted
// 429s from hitting Vertex with many simultaneous calls.
const MAX_CONCURRENT_GENERATIONS = 3;
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

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("library");
  const [tray, setTray] = useState<ImageRow[]>([]);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [queue, setQueue] = useState<QueueTask[]>([]);
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

  // --- Generation queue (lives in App so it survives tab switches) ---
  const enqueue = (task: Omit<QueueTask, "id" | "status">) =>
    setQueue((q) => [
      ...q,
      { ...task, id: crypto.randomUUID(), status: "pending" },
    ]);

  const removeTask = (id: string) =>
    setQueue((q) => q.filter((t) => !(t.id === id && t.status !== "running")));

  const clearDone = () =>
    setQueue((q) =>
      q.filter((t) => t.status === "pending" || t.status === "running"),
    );

  // Bounded FIFO processor: allow several generations without flooding Vertex.
  const startedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const running = queue.filter((t) => t.status === "running").length;
    const slots = MAX_CONCURRENT_GENERATIONS - running;
    if (slots <= 0) return;

    const nextTasks = queue
      .filter((t) => t.status === "pending" && !startedRef.current.has(t.id))
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
        })
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
  }, [queue]);

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
            clearDone={clearDone}
            onOpenViewer={openViewer}
          />
        </main>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={refreshConfig}
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
