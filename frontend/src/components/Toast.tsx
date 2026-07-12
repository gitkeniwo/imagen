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
}

const TOAST_DURATION_MS = 4000;

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(
  () => {},
);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, kind: ToastKind = "error") => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(
      () => setToasts((ts) => ts.filter((x) => x.id !== id)),
      TOAST_DURATION_MS,
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
            {x.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
