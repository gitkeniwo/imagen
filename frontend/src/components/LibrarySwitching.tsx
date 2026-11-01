import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import { Button } from "./ui/Button";

const POLL_MS = 1000;
const FAIL_FAST_MS = 15_000;
const TIMEOUT_MS = 60_000;

export default function LibrarySwitching({
  name,
  hostName,
  previousKey,
}: {
  name: string;
  hostName: string;
  previousKey: string;
}) {
  const { t } = useI18n();
  const [startedAt, setStartedAt] = useState(Date.now());
  const [failed, setFailed] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    if (failed) return;
    let cancelled = false;
    let reachableSince: number | null = null;
    const current = ++attempt.current;

    const poll = async () => {
      if (cancelled || attempt.current !== current) return;
      try {
        const library = await api.getLibrary();
        if (cancelled || attempt.current !== current) return;
        if (library.key && library.key !== previousKey) {
          location.reload();
          return;
        }
        reachableSince ??= Date.now();
        if (Date.now() - reachableSince >= FAIL_FAST_MS) {
          setFailed(true);
          return;
        }
      } catch {
        reachableSince = null;
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        setFailed(true);
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [failed, previousKey, startedAt]);

  const retry = () => {
    setFailed(false);
    setStartedAt(Date.now());
  };

  return createPortal(
    <div
      className="library-switching"
      role={failed ? "alert" : "status"}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="library-switching-card">
        {failed ? (
          <>
            <span className="library-switching-warn">
              <Icon name="warning" size="lg" />
            </span>
            <h2>{t("library_switch_failed_t")}</h2>
            <p>{t("library_switch_failed_b")}</p>
            <Button variant="primary" onClick={retry}>{t("remote_retry")}</Button>
          </>
        ) : (
          <>
            <span className="library-switching-spinner" aria-hidden="true" />
            <h2>{t("library_switch_working_t", { name })}</h2>
            <p>{t("library_switch_working_b", { host: hostName })}</p>
            <div className="library-switching-steps">
              <span><Icon name="check" size="sm" />{t("library_switch_step_sent")}</span>
              <span><Icon name="refresh" size="sm" />{t("library_switch_step_wait")}</span>
              <span className="pending"><Icon name="radio" size="sm" />{t("library_switch_step_reconnect")}</span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
