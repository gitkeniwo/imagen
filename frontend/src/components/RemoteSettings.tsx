import { useState } from "react";
import { remoteApi } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import { Button } from "./ui/Button";
import { Switch } from "./ComposerControls";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { addressUrl, deviceIcon, reasonText, seenLabel, useRemoteStatus } from "./RemoteIndicator";

const TAILSCALE_URL = "https://tailscale.com";

// Settings › Remote access (host window only).
export default function RemoteSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const { status: s, setStatus, refresh } = useRemoteStatus(3000);
  const [show, setShow] = useState(false);
  const [editPort, setEditPort] = useState(false);
  const [portText, setPortText] = useState("");
  const [portErr, setPortErr] = useState(false);
  if (!s) return null;

  const fail = (e: unknown) => {
    toast(t("remote_error", { msg: (e as Error).message }), "error");
    void refresh();
  };
  const configure = async (patch: Parameters<typeof remoteApi.configure>[0]) => {
    try {
      setStatus(await remoteApi.configure(patch));
    } catch (e) {
      fail(e);
    }
  };
  const copy = async (text: string) => toast((await copyText(text)) ? t("copied") : t("copy_failed"), "info");
  const on = s.state !== "off";
  const reason = reasonText(t, s);
  const fwKey = s.firewall === "ok" ? "remote_fw_ok" : s.firewall === "blocked" ? "remote_fw_blocked" : "remote_fw_unknown";

  const setRequireCode = async (v: boolean) => {
    if (!v) {
      const ok = await askConfirm({
        title: t("remote_nocode_confirm_t"),
        message: t("remote_nocode_b"),
        confirmLabel: t("remote_nocode_confirm_ok"),
        danger: true,
      });
      if (!ok) return;
    }
    await configure({ require_code: v });
  };
  const regenerate = async () => {
    if (s.devices.length > 0) {
      const ok = await askConfirm({ message: t("remote_new_code_confirm"), confirmLabel: t("remote_new_code"), danger: true });
      if (!ok) return;
    }
    try {
      setStatus(await remoteApi.regenerateCode());
    } catch (e) {
      fail(e);
    }
  };
  const applyPort = async () => {
    const p = Number(portText);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      setPortErr(true);
      return;
    }
    setPortErr(false);
    setEditPort(false);
    await configure({ port: p });
  };

  return (
    <div className="settings-body">
      <div className="rm-card">
        <span className={`rm-card-icon${on ? "" : " off"}`}><Icon name="radio" /></span>
        <div className="rm-card-text">
          <span className="rm-card-title">
            {t("remote_title")}
            <span className={`rm-chip ${on ? "ok" : "neutral"}`}>
              {on && <span className="rm-dot live" />}
              {on ? t("remote_on") : t("remote_off")}
            </span>
          </span>
          <span className="muted small">{t("remote_card_desc")}</span>
        </div>
        <Switch checked={on} onChange={(v) => configure({ enabled: v })} label="" title={t("remote_title")} />
      </div>

      {reason && <div className="rm-callout warn"><Icon name="warning" size="sm" /><span>{reason}</span></div>}

      {!on && (
        <div className="settings-group">
          <h4>{t("remote_how")}</h4>
          <div className="rm-steps">
            {[1, 2, 3].map((n) => (
              <div key={n} className="rm-step">
                <span className="rm-step-n">{n}</span>
                <b>{t(`remote_step${n}_t`)}</b>
                <span>{t(`remote_step${n}_b`)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {on && (
        <>
          <div className="settings-group rm-group">
            <h4>
              {t("remote_addresses")}
              <span className="rm-aside">
                {t("remote_port", { port: s.port })}
                <Button size="sm" variant="link" onClick={() => { setPortText(String(s.port)); setEditPort((v) => !v); }}>
                  {t("remote_change")}
                </Button>
              </span>
            </h4>
            {editPort && (
              <form className="rm-port" onSubmit={(e) => { e.preventDefault(); void applyPort(); }}>
                <input
                  inputMode="numeric"
                  aria-label={t("remote_port_label")}
                  value={portText}
                  autoFocus
                  onChange={(e) => setPortText(e.target.value)}
                />
                <Button type="submit" variant="primary" size="sm">{t("remote_port_apply")}</Button>
                {portErr && <span className="small" style={{ color: "var(--danger)" }}>{t("remote_port_bad")}</span>}
              </form>
            )}
            <div className="rm-rows">
              {s.addresses.length === 0 && <div className="rm-row"><span className="muted small">{t("remote_addr_none")}</span></div>}
              {s.addresses.map((a) => (
                <div key={a.ip} className="rm-row">
                  <Icon name={a.kind === "tailscale" ? "shield" : "globe"} size="sm" />
                  <span className="rm-row-text">
                    <span className="rm-mono">{addressUrl(a.ip, s.port)}</span>
                    <span>{t(`remote_addr_${a.kind}`, { iface: a.iface })}</span>
                  </span>
                  <Button size="sm" icon="copy" onClick={() => copy(addressUrl(a.ip, s.port))}>{t("remote_copy")}</Button>
                </div>
              ))}
              {s.local_name && (
                <div className="rm-row">
                  <Icon name="globe" size="sm" />
                  <span className="rm-row-text">
                    <span className="rm-mono">{addressUrl(s.local_name, s.port)}</span>
                    <span>{t("remote_addr_local")}</span>
                  </span>
                  <Button size="sm" icon="copy" onClick={() => copy(addressUrl(s.local_name!, s.port))}>{t("remote_copy")}</Button>
                </div>
              )}
            </div>
          </div>

          <div className="settings-group">
            <h4>{t("remote_access_code")}</h4>
            <div className="rm-rows">
              <div className="rm-row">
                <Icon name="lock" size="sm" />
                <span className="rm-row-text">
                  <b>{t("remote_require_code")}</b>
                  <span>{t("remote_code_help", { n: s.failed_last_hour })}</span>
                </span>
                <Switch checked={s.require_code} onChange={setRequireCode} label="" title={t("remote_require_code")} />
              </div>
            </div>
            {s.require_code && s.code && (
              <div className="rm-codebox">
                <span className="rm-code">{show ? s.code : "•••••"}</span>
                <Button size="sm" variant="link" onClick={() => setShow((v) => !v)}>
                  {show ? t("remote_hide") : t("remote_show")}
                </Button>
                <Button size="sm" icon="copy" onClick={() => copy(s.code!)}>{t("remote_copy_code")}</Button>
                <Button size="sm" icon="refresh" onClick={regenerate}>{t("remote_new_code")}</Button>
              </div>
            )}
            {!s.require_code && (
              <div className="rm-callout warn">
                <Icon name="unlock" size="sm" />
                <span><b>{t("remote_nocode_t")}</b> {t("remote_nocode_b")}</span>
              </div>
            )}
          </div>

          {s.devices.length > 0 && (
            <div className="settings-group rm-group">
              <h4>
                {t("remote_signed_devices")}
                <Button size="sm" variant="link" className="rm-danger" onClick={async () => {
                  try { setStatus(await remoteApi.signOutAll()); } catch (e) { fail(e); }
                }}>
                  {t("remote_sign_out_all")}
                </Button>
              </h4>
              <div className="rm-rows">
                {s.devices.map((d) => (
                  <div key={d.id} className="rm-row">
                    <Icon name={deviceIcon(d.name)} size="sm" />
                    <span className="rm-row-text">
                      <b>{d.name}</b>
                      <span>
                        {d.active ? t("remote_active") : seenLabel(t, d.last_seen)} · {d.ip}
                        {d.running > 0 ? ` · ${t("remote_generating", { n: d.running })}` : ""}
                      </span>
                    </span>
                    <Button size="sm" onClick={async () => {
                      try { setStatus(await remoteApi.signOutDevice(d.id)); } catch (e) { fail(e); }
                    }}>
                      {t("remote_sign_out")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rm-rows">
            <div className="rm-row">
              <Icon name="moon" size="sm" />
              <span className="rm-row-text">
                <b>{t("remote_awake_t")}</b>
                <span>{t("remote_awake_d")}</span>
              </span>
              <Switch checked={s.keep_awake} onChange={(v) => configure({ keep_awake: v })} label="" title={t("remote_awake_t")} />
            </div>
            <div className="rm-row">
              <Icon name="shield" size="sm" />
              <span className="rm-row-text">
                <b>{t("remote_firewall")}</b>
                <span>{t("remote_firewall_d")}</span>
              </span>
              <span className={`rm-chip ${s.firewall === "blocked" ? "warn" : s.firewall === "ok" ? "ok" : "neutral"}`}>
                {t(fwKey)}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="rm-note">
        <Icon name="info" size="sm" />
        <span>
          {t("remote_http_pre")}
          <a
            href={TAILSCALE_URL}
            onClick={(e) => {
              // The shell blocks navigation to external sites; hand over the link instead.
              e.preventDefault();
              void copy(TAILSCALE_URL).then(() => toast(t("remote_link_copied"), "info"));
            }}
          >
            Tailscale
          </a>
          {t("remote_http_post")}
        </span>
      </div>
    </div>
  );
}
