import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";
import { useBackLayer } from "../backStack";
import "./confirm-dialog.css";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the red confirm button. */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface ActiveConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm() {
  return useContext(ConfirmContext);
}

/**
 * Promise-based replacement for the native confirm dialog.
 *
 * WKWebView has no synchronous JavaScript confirm panel. The dialog plugin
 * injects an async shim that returns a Promise, so a truthiness guard sees the
 * Promise object as true and never waits. This component keeps the same call
 * shape for callers while rendering a real React dialog that works in both a
 * browser and the Tauri app.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [request, setRequest] = useState<ActiveConfirm | null>(null);
  const requestRef = useRef<ActiveConfirm | null>(null);

  const close = useCallback((result: boolean) => {
    const current = requestRef.current;
    if (!current) return;
    requestRef.current = null;
    setRequest(null);
    current.resolve(result);
  }, []);

  const ask = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // There should only ever be one dialog. If a second request races in,
      // cancel the old one rather than leaving a Promise unresolved.
      requestRef.current?.resolve(false);
      const next = { ...options, resolve };
      requestRef.current = next;
      setRequest(next);
    });
  }, []);

  useEffect(() => {
    return () => {
      requestRef.current?.resolve(false);
      requestRef.current = null;
    };
  }, []);

  // Back cancels the dialog, exactly like Escape or the backdrop.
  useBackLayer(request !== null, () => close(false));

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if (event.key === "Enter") {
        // Never let Enter fall through to the destructive button. Users must
        // click the confirm button or press Escape to cancel.
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close]);

  const title = request?.title ?? t("confirm_title");
  const cancelLabel = request?.cancelLabel ?? t("cancel");
  const confirmLabel = request?.confirmLabel ?? t("confirm");

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {request && (
        <div
          className="overlay confirm-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
          onClick={() => close(false)}
        >
          <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-dialog-title" className="mt-0">
              {title}
            </h3>
            <p id="confirm-dialog-message" className="confirm-message">
              {request.message}
            </p>
            <div className="modal-actions">
              <button autoFocus onClick={() => close(false)}>
                {cancelLabel}
              </button>
              <button
                className={request.danger ? "danger-btn" : "primary"}
                onClick={() => close(true)}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
