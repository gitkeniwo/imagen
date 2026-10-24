import { useEffect, useRef } from "react";

// Browser back (iOS edge swipe, Android back key, trackpad two-finger swipe,
// mouse side button) closes the topmost in-app layer instead of leaving Imagen.
// Every open layer owns one history entry tagged with `imagenDepth`; the URL is
// never changed, so query params (`?fakeRemote=`) survive. Forward navigation
// is swallowed: it never reopens a layer.
type Layer = {
  id: number;
  // Refreshed on every render so the popstate handler never runs a stale
  // closure (e.g. a DraftEditor's `saving` flag).
  onBack: { current: () => void | boolean };
};

let nextLayerId = 1;
// Mount order: the top of the stack is the visually topmost layer.
const stack: Layer[] = [];
// True while a history.go() we issued is still waiting for its popstate.
let navPending = false;
let reconcileScheduled = false;

function depthOf(state: unknown): number {
  const depth = (state as { imagenDepth?: unknown } | null)?.imagenDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

function pushDepth(depth: number) {
  const base =
    history.state && typeof history.state === "object"
      ? (history.state as Record<string, unknown>)
      : {};
  history.pushState({ ...base, imagenDepth: depth }, "");
}

// Steady-state invariant: history.state.imagenDepth === stack.length.
function reconcile() {
  if (navPending) return;
  const current = depthOf(history.state);
  const target = stack.length;
  if (current < target) {
    // pushState is synchronous, so missing entries are filled in one pass.
    let depth = current;
    while (depth < target) {
      depth += 1;
      pushDepth(depth);
    }
  } else if (current > target) {
    // A layer was closed by the UI (button, Esc, backdrop, unmount): drop the
    // matching history entry, then settle in the popstate handler.
    navPending = true;
    history.go(target - current);
  }
}

// Stack changes never touch history directly. They coalesce into one reconcile
// so StrictMode's mount/unmount/mount ends up adding a single entry, and a
// parent closing with its child steps back once.
function scheduleReconcile() {
  if (reconcileScheduled) return;
  reconcileScheduled = true;
  queueMicrotask(() => {
    reconcileScheduled = false;
    reconcile();
  });
}

function onPopState(event: PopStateEvent) {
  if (navPending) {
    // Our own history.go() landed. The stack may have changed while waiting.
    navPending = false;
    reconcile();
    return;
  }

  const depth = depthOf(event.state);
  if (depth < stack.length) {
    // Back: close layers from the top down. A layer can veto (e.g. a save is
    // in flight); it is put back and gets a fresh entry, then the walk stops.
    while (stack.length > depth) {
      const layer = stack[stack.length - 1];
      stack.pop();
      if (layer.onBack.current() === false) {
        stack.push(layer);
        pushDepth(stack.length);
        break;
      }
    }
  } else if (depth > stack.length) {
    // Forward: closed layers stay closed, so walk back to the matching entry.
    navPending = true;
    history.go(stack.length - depth);
  }
}

if (typeof window !== "undefined") {
  // A reload leaves entries for layers the fresh render no longer has. Drop
  // them so the first back press still leaves the app instead of doing
  // nothing visible.
  const leftover = depthOf(history.state);
  if (leftover > 0) {
    navPending = true;
    history.go(-leftover);
  }
  window.addEventListener("popstate", onPopState);
}

// Call from a layer component while it is open; `onBack` should do exactly what
// the layer's own close button does. Returning false keeps the layer open.
export function useBackLayer(active: boolean, onBack: () => void | boolean): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { id: nextLayerId++, onBack: onBackRef };
    stack.push(layer);
    scheduleReconcile();
    return () => {
      // Back already removed this layer before calling onBack; only a UI close
      // (or an unmount) still finds it on the stack.
      const index = stack.indexOf(layer);
      if (index === -1) return;
      stack.splice(index, 1);
      scheduleReconcile();
    };
  }, [active]);
}
