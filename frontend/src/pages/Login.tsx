import { type FormEvent, useEffect, useRef, useState } from "react";
import { remoteApi } from "../api";
import { useI18n } from "../i18n";
import appIcon from "../assets/app-icon.png";
import Icon from "../components/ui/Icon";
import { Button } from "../components/ui/Button";

const CODE_LEN = 5;

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  // iPadOS Safari reports a Mac UA; touch points tell them apart.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const device = ipad ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : "Safari";
  return `${device} · ${browser}`;
}

function mmss(secs: number) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// Served at /login on the LAN listener; reachable without a session.
export default function Login() {
  const { t } = useI18n();
  const [hostName, setHostName] = useState("");
  const [requireCode, setRequireCode] = useState(true);
  // Docker server mode: no Mac, no device list; the code is set by env var.
  const [server, setServer] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(guessDeviceName);
  const [editing, setEditing] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"wrong" | "network" | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    remoteApi
      .hello()
      .then((h) => {
        setHostName(h.host_name);
        setRequireCode(h.require_code);
        setServer(!!h.server);
      })
      .catch(() => {});
  }, []);

  const locked = lockedUntil > now;
  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [locked]);
  // The field is disabled while a request is in flight, which drops focus.
  useEffect(() => {
    if (!locked && !busy) input.current?.focus();
  }, [locked, busy]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || locked || (requireCode && code.length !== CODE_LEN)) return;
    setBusy(true);
    setError(null);
    const res = await remoteApi.login(code, name.trim() || guessDeviceName(), remember);
    setBusy(false);
    if (res.ok) {
      location.replace("/");
    } else if (res.error === "wrong_code") {
      setError("wrong");
      setRemaining(res.remaining);
    } else if (res.error === "locked") {
      setNow(Date.now());
      setLockedUntil(Date.now() + res.retryAfter * 1000);
    } else {
      setError("network");
    }
  };

  const onCode = (v: string) => {
    // After a wrong code the digits stay on screen; typing starts a fresh code.
    const typed = error === "wrong" && v.length > code.length ? v.slice(code.length) : v;
    setError(null);
    setCode(typed.replace(/\D/g, "").slice(0, CODE_LEN));
  };

  const secsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const cells = Array.from({ length: CODE_LEN }, (_, i) => {
    const cls = locked ? "dis" : error === "wrong" ? "err" : i === code.length ? "cur" : "";
    return (
      <span key={i} className={`rm-cell ${cls}`}>
        {code[i] ?? ""}
      </span>
    );
  });

  return (
    <div className="rm-login">
      <form className="rm-login-card" onSubmit={submit} aria-label={t("login_title")}>
        <div className="rm-login-brand">
          <img className="brand-icon" src={appIcon} alt="" />
          <b>Imagen</b>
          {hostName && <span className="rm-chip neutral"><Icon name="laptop" size="sm" />{hostName}</span>}
        </div>
        <div className="rm-login-head">
          <h1>{t("login_title")}</h1>
          <p className="muted small m-0">{t(server ? "login_sub_server" : "login_sub")}</p>
        </div>

        {requireCode && (
          <div className="rm-cells-wrap">
            <div className="rm-cells" role="group" aria-label={t("login_code_aria")}>{cells}</div>
            <input
              ref={input}
              className="rm-cells-input"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              aria-label={t("login_code_aria")}
              value={code}
              disabled={locked || busy}
              autoFocus
              onChange={(e) => onCode(e.target.value)}
            />
          </div>
        )}

        {error === "wrong" && (
          <div className="rm-login-msg err" role="alert">
            <Icon name="warning" size="sm" />
            <span>{remaining > 1 ? t("login_wrong", { n: remaining }) : t("login_wrong_last")}</span>
          </div>
        )}
        {error === "network" && (
          <div className="rm-login-msg err" role="alert"><Icon name="wifiOff" size="sm" /><span>{t(server ? "login_network_server" : "login_network")}</span></div>
        )}
        {locked && (
          <div className="rm-login-msg warn" role="alert">
            <Icon name="lock" size="sm" />
            <span>{t("login_locked", { time: mmss(secsLeft) })}</span>
          </div>
        )}

        {server ? null : editing ? (
          <div>
            <label className="rm-lbl" htmlFor="dev-name">
              {t("login_device_label")} <span className="muted" style={{ fontWeight: 400 }}>{t("login_device_hint")}</span>
            </label>
            <input
              id="dev-name"
              className="rm-name"
              value={name}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : (
          <div className="rm-devname">
            <Icon name="tablet" size="sm" />
            <span>{t("login_device_line", { name })}</span>
            <Button variant="link" size="sm" onClick={() => setEditing(true)}>{t("login_rename")}</Button>
          </div>
        )}
        <label className="rm-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("login_remember")}
        </label>
        <Button
          type="submit"
          variant="primary"
          className="rm-go"
          disabled={busy || locked || (requireCode && code.length !== CODE_LEN)}
        >
          {t("login_connect")}
        </Button>
      </form>
      {!server && <p className="rm-login-foot"><Icon name="radio" size="sm" />{t("login_foot")}</p>}
    </div>
  );
}
