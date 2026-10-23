import { useCallback, useEffect, useRef, useState } from "react";
import { remoteApi, type RemoteStatus } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import Icon, { type IconName } from "./ui/Icon";
import { Button } from "./ui/Button";
import { Switch } from "./ComposerControls";
import { useToast } from "./Toast";
import { useRemote } from "../remote";

type T = (key: string, vars?: Record<string, string | number>) => string;

// Host-side view of remote access: polls the loopback-only status endpoint.
export function useRemoteStatus(intervalMs = 5000) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await remoteApi.status());
    } catch {
      /* older backend / Docker: no remote UI */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(id);
  }, [refresh, intervalMs]);
  return { status, setStatus, refresh };
}

export function deviceIcon(name: string): IconName {
  if (/ipad/i.test(name)) return "tablet";
  if (/iphone|phone/i.test(name)) return "phone";
  return "laptop";
}

export function seenLabel(t: T, ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return t("remote_seen_now");
  if (s < 3600) return t("remote_seen_min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("remote_seen_h", { n: Math.floor(s / 3600) });
  return t("remote_seen_d", { n: Math.floor(s / 86400) });
}

export function addressUrl(ip: string, port: number) {
  return `http://${ip}:${port}`;
}

export function mainAddress(s: RemoteStatus) {
  const a = s.addresses.find((x) => x.kind === "wifi") ?? s.addresses.find((x) => x.kind !== "tailscale");
  return a ? addressUrl(a.ip, s.port) : null;
}

export function reasonText(t: T, s: RemoteStatus): string | null {
  if (!s.reason) return null;
  const key = `remote_reason_${s.reason}`;
  const text = t(key, { port: s.port, reason: s.reason });
  return text === key ? t("remote_reason_other", { reason: s.reason }) : text;
}

export default function RemoteIndicator({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);
  const { status, setStatus, refresh } = useRemoteStatus(open ? 2000 : 5000);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!status?.available) return null;
  const s = status;
  const fail = (e: unknown) => toast(t("remote_error", { msg: (e as Error).message }), "error");
  const toggle = async (enabled: boolean) => {
    try {
      setStatus(await remoteApi.configure({ enabled }));
    } catch (e) {
      fail(e);
      void refresh();
    }
  };
  const copy = async (text: string) => {
    toast((await copyText(text)) ? t("copied") : t("copy_failed"), "info");
  };

  const n = s.devices.length;
  const on = s.state !== "off";
  const pillClass =
    s.state === "blocked" ? "warn" : s.state === "no_code" ? "nocode" : s.state === "active" ? "active" : s.state === "off" ? "off" : "";
  const main = mainAddress(s);
  const local = s.local_name ? addressUrl(s.local_name, s.port) : null;
  const sub =
    s.state === "off"
      ? t("remote_sub_off")
      : s.require_code
        ? t("remote_sub_on", { port: s.port })
        : t("remote_sub_nocode", { port: s.port });
  const activeCount = s.devices.filter((d) => d.active).length;

  return (
    <div className="rm-wrap" ref={wrap}>
      <button
        type="button"
        className={`rm-pill ${pillClass}${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("remote_title")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.state === "active" ? "rm-radio-live" : undefined}>
          <Icon name={s.state === "blocked" || s.state === "no_code" ? "warning" : "radio"} />
        </span>
        {s.state === "blocked" ? t("remote_blocked_pill")
          : s.state === "no_code" ? t("remote_no_code")
          : s.state === "off" ? null
          : s.state === "active" ? <>{t("remote_pill")}<span className="rm-count">{n}</span></>
          : <>{t("remote_pill")}<span className="rm-dot live soft" /></>}
      </button>

      {open && (
        <div className="rm-pop" role="dialog" aria-label={t("remote_title")}>
          <div className="rm-pop-head">
            <div className="rm-pop-title">
              <b>{t("remote_title")}</b>
              <span className="muted small">{sub}</span>
            </div>
            <Switch checked={on} onChange={toggle} label="" title={t("remote_title")} />
          </div>

          {s.state === "off" && (
            <div className="rm-pop-off">
              <span>{reasonText(t, s) ?? t("remote_off_blurb")}</span>
              <div className="rm-fact"><Icon name="key" size="sm" />{t("remote_fact_code")}</div>
              <div className="rm-fact"><Icon name="globe" size="sm" />{t("remote_fact_addr")}</div>
            </div>
          )}

          {on && (
            <>
              {s.reason && (
                <div className="rm-pop-sec">
                  <div className="rm-callout warn"><Icon name="warning" size="sm" /><span>{reasonText(t, s)}</span></div>
                </div>
              )}
              {!s.reason && !s.require_code && (
                <div className="rm-pop-sec">
                  <div className="rm-callout warn">
                    <Icon name="unlock" size="sm" />
                    <span><b>{t("remote_nocode_t")}</b> {t("remote_nocode_b")}</span>
                  </div>
                </div>
              )}
              {main && (
                <div className="rm-pop-sec">
                  <div className="rm-pop-label">
                    <span>{t("remote_open_on_ipad")}</span>
                    <span className="rm-plain muted">{t("remote_same_wifi")}</span>
                  </div>
                  <div className="rm-addr">
                    <span className="rm-mono">{main}</span>
                    <Button size="sm" icon="copy" onClick={() => copy(main)}>{t("remote_copy")}</Button>
                  </div>
                  {local && (
                    <div className="rm-addr minor">
                      <span className="rm-mono">{local}</span>
                      <Button size="sm" variant="link" onClick={() => copy(local)}>{t("remote_copy")}</Button>
                    </div>
                  )}
                </div>
              )}
              {s.require_code && s.code && (
                <div className="rm-pop-sec">
                  <div className="rm-pop-label"><span>{t("remote_access_code")}</span></div>
                  <div className="rm-addr">
                    <span className="rm-code">{show ? s.code : "•••••"}</span>
                    <span className="rm-mono" />
                    <Button size="sm" variant="link" onClick={() => setShow((v) => !v)}>
                      {show ? t("remote_hide") : t("remote_show")}
                    </Button>
                    <Button size="sm" icon="copy" onClick={() => copy(s.code!)}>{t("remote_copy_code")}</Button>
                  </div>
                </div>
              )}
              <div className="rm-pop-sec">
                <div className="rm-pop-label">
                  <span>{t("remote_devices")}</span>
                  <span className="rm-plain muted">
                    {n === 0 ? "" : t("remote_devices_count", { active: activeCount, total: n })}
                  </span>
                </div>
                {n === 0 && !s.anon_active && <span className="muted small">{t("remote_no_devices")}</span>}
                {s.devices.map((d) => (
                  <div key={d.id} className="rm-dev">
                    <span className={`rm-dev-ic${d.active ? " on" : ""}`}><Icon name={deviceIcon(d.name)} size="sm" /></span>
                    <span className="rm-dev-text">
                      <b>{d.name}</b>
                      <span>
                        {d.active ? t("remote_active") : seenLabel(t, d.last_seen)}
                        {d.running > 0 ? ` · ${t("remote_generating", { n: d.running })}` : ""}
                      </span>
                    </span>
                  </div>
                ))}
                {s.anon_active && (
                  <div className="rm-dev">
                    <span className="rm-dev-ic on"><Icon name="globe" size="sm" /></span>
                    <span className="rm-dev-text">
                      <b>{t("remote_active")}</b>
                      {s.anon_running > 0 && <span>{t("remote_generating", { n: s.anon_running })}</span>}
                    </span>
                  </div>
                )}
                {s.keep_awake && <div className="rm-fact"><Icon name="moon" size="sm" />{t("remote_fact_awake")}</div>}
                {s.failed_last_hour > 0 && (
                  <div className="rm-fact"><Icon name="shield" size="sm" />{t("remote_fact_fails", { n: s.failed_last_hour })}</div>
                )}
              </div>
            </>
          )}

          <div className="rm-pop-foot">
            <Button size="sm" variant="link" onClick={() => { setOpen(false); onOpenSettings(); }}>
              {t("remote_settings_link")}
            </Button>
            {on && n > 0 && (
              <Button size="sm" variant="link" className="rm-danger" onClick={async () => {
                try { setStatus(await remoteApi.signOutAll()); } catch (e) { fail(e); }
              }}>
                {t("remote_sign_out_all")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// iPad side: who this device is connected to, and whether the Mac is reachable.
export function RemoteChip() {
  const { t } = useI18n();
  const { hostName, device, conn, retry, signOut } = useRemote();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const lost = conn === "lost";
  return (
    <div className="rm-wrap" ref={wrap}>
      <button
        type="button"
        className={`rm-connpill${lost ? " lost" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (lost ? retry() : setOpen((v) => !v))}
      >
        {lost ? (
          <>
            <span className="rm-dot warn" />
            {t("remote_offline_retry")}
          </>
        ) : (
          <>
            <span className="rm-dot live" />
            <Icon name="laptop" size="sm" />
            <span className="rm-host">{hostName}</span>
          </>
        )}
      </button>
      {open && !lost && (
        <div className="rm-menu" role="menu">
          <div className="rm-menu-item">
            <span>{t("remote_menu_address")}</span>
            <b>{location.host}</b>
          </div>
          <div className="rm-menu-item">
            <span>{t("remote_menu_device")}</span>
            <b>{device?.name ?? "—"}</b>
          </div>
          <button type="button" className="rm-menu-out" role="menuitem" onClick={() => void signOut()}>
            <Icon name="logout" size="sm" />
            {t("remote_sign_out_this")}
          </button>
        </div>
      )}
    </div>
  );
}
