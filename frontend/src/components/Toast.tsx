import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Tiny dependency-free toast system. Mutation failures were previously
// swallowed (or used native alert); pages call useToast() to surface them.

export type ToastKind = "error" | "success" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  durationMs: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const TOAST_DURATION_MS = 4000;

export interface ToastOptions {
  durationMs?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const ToastContext = createContext<(
  text: string,
  kind?: ToastKind,
  options?: ToastOptions,
) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((
    text: string,
    kind: ToastKind = "error",
    options: ToastOptions = {},
  ) => {
    const id = nextId.current++;
    const durationMs = options.durationMs ?? TOAST_DURATION_MS;
    setToasts((ts) => [...ts, { id, kind, text, durationMs, action: options.action }]);
    setTimeout(
      () => setToasts((ts) => ts.filter((x) => x.id !== id)),
      durationMs,
    );
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div
            key={x.id}
            className={`toast ${x.kind}`}
            onClick={() => setToasts((ts) => ts.filter((y) => y.id !== x.id))}
          >
            <span>{x.text}</span>
            {x.action && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  x.action?.onClick();
                  setToasts((ts) => ts.filter((y) => y.id !== x.id));
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
