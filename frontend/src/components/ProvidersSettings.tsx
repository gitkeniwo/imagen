import { useEffect, useState } from "react";
import {
  api,
  isProviderId,
  ProviderCheck,
  ProviderId,
  ProviderInfo,
} from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import { useRemote } from "../remote";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import Icon from "./ui/Icon";

function statusOf(provider: ProviderInfo): "ready" | "setup" | "off" {
  if (!provider.enabled) return "off";
  return provider.configured ? "ready" : "setup";
}

function statusLabel(
  t: (key: string) => string,
  status: ReturnType<typeof statusOf>,
) {
  if (status === "ready") return t("provider_ready");
  if (status === "off") return t("provider_off");
  return t("provider_not_set_up");
}

const errorKey = (message: string) =>
  ["last_provider", "key_from_env", "key_env_only"].includes(message)
    ? `provider_error_${message}`
    : null;

export default function ProvidersSettings({
  initialProvider,
  onSaved,
}: {
  initialProvider?: ProviderId;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { providers, enabled, loading, reload } = useProviders();
  const { remote } = useRemote();
  const askConfirm = useConfirm();
  const [selected, setSelected] = useState<ProviderId>(
    initialProvider && isProviderId(initialProvider) ? initialProvider : "vertex",
  );
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("global");
  const [keyInput, setKeyInput] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const info = providers.find((provider) => provider.id === selected);
  const detail = info?.detail;

  useEffect(() => {
    if (initialProvider && isProviderId(initialProvider)) {
      setSelected(initialProvider);
    }
  }, [initialProvider]);

  useEffect(() => {
    if (!info) return;
    setProject(info.detail.project ?? "");
    setLocation(info.detail.location || "global");
    setKeyInput("");
    setReplacingKey(false);
    setCheck(null);
    setErr(null);
  }, [
    selected,
    info?.detail.project,
    info?.detail.location,
    info?.detail.keySource,
    info?.detail.keyLast4,
  ]);

  const shownError = (cause: unknown) => {
    const message = (cause as Error).message;
    const key = errorKey(message);
    setErr(key ? t(key) : message);
  };

  const toggleProvider = async (provider: ProviderInfo) => {
    if (remote || (provider.enabled && enabled.length === 1)) return;
    setErr(null);
    try {
      const next = await api.setProviderEnabled(provider.id, !provider.enabled);
      await reload(next.providers);
      onSaved();
    } catch (cause) {
      shownError(cause);
    }
  };

  const save = async () => {
    if (!info || remote) return;
    setSaving(true);
    setErr(null);
    try {
      if (selected === "vertex") {
        await api.setVertex(project.trim(), location.trim() || "global");
      } else {
        const next = await api.setGeminiKey(keyInput.trim());
        await reload(next.providers);
      }
      const latest = await api.getProviders();
      await reload(latest.providers);
      onSaved();
      setKeyInput("");
      setReplacingKey(false);
    } catch (cause) {
      shownError(cause);
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    const ok = await askConfirm({
      title: t("gemini_remove_title"),
      message: t("gemini_remove_confirm"),
      confirmLabel: t("gemini_key_remove"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    setErr(null);
    try {
      const next = await api.deleteGeminiKey();
      await reload(next.providers);
      onSaved();
    } catch (cause) {
      shownError(cause);
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    if (!info || remote) return;
    setChecking(true);
    setErr(null);
    setCheck(null);
    try {
      setCheck(await api.checkProvider(info.id));
    } catch (cause) {
      shownError(cause);
    } finally {
      setChecking(false);
    }
  };

  if (loading && providers.length === 0) {
    return <div className="settings-body muted">{t("loading")}</div>;
  }

  const source = detail?.keySource ?? null;
  const keyStorage = detail?.keyStorage;
  const last4 = detail?.keyLast4;
  const showKeyInput =
    selected === "gemini" &&
    keyStorage !== "env" &&
    keyStorage !== "env_only" &&
    (!source || replacingKey);

  const canSave =
    !remote &&
    !saving &&
    !!info &&
    (selected === "vertex"
      ? !!project.trim()
      : keyStorage !== "env" &&
        keyStorage !== "env_only" &&
        (!source || replacingKey) &&
        !!keyInput.trim());

  const expectedMissing =
    check?.expected?.filter((model) => !model.found).map((model) => model.wireId) ?? [];

  return (
    <div className="settings-body providers-settings">
      {remote && (
        <div className="rm-callout lock">
          <Icon name="lock" size="sm" />
          <span>{t("providers_lan_lock")}</span>
        </div>
      )}

      <div className="providers-layout">
        <aside className="providers-list">
          {providers.map((provider) => {
            const status = statusOf(provider);
            const lastOn = provider.enabled && enabled.length === 1;
            return (
              <div
                key={provider.id}
                className={`provider-row${selected === provider.id ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="provider-row-select"
                  aria-pressed={selected === provider.id}
                  onClick={() => setSelected(provider.id)}
                >
                  <span className="provider-row-icon">
                    <Icon name={provider.id === "vertex" ? "cloud" : "key"} size="sm" />
                  </span>
                  <span className="provider-row-copy">
                    <span className="provider-row-name">{provider.label}</span>
                    <span className={`provider-row-status ${status}`}>
                      <span className="provider-status-dot" />
                      {statusLabel(t, status)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  className={`provider-switch${provider.enabled ? " on" : ""}`}
                  aria-checked={provider.enabled}
                  aria-label={t("provider_use", { provider: provider.label })}
                  title={lastOn ? t("provider_keep_one") : undefined}
                  disabled={remote || lastOn}
                  onClick={() => void toggleProvider(provider)}
                >
                  <span />
                </button>
              </div>
            );
          })}
          <p className="providers-list-note">{t("providers_off_note")}</p>
        </aside>

        {info && (
          <section className="provider-detail">
            <header className="provider-detail-head">
              <div>
                <h4>{info.label}</h4>
                <p>
                  {info.id === "vertex"
                    ? t("provider_vertex_subtitle")
                    : t("provider_gemini_subtitle")}
                </p>
              </div>
              <span className={`provider-pill ${statusOf(info)}`}>
                <span className="provider-status-dot" />
                {statusLabel(t, statusOf(info))}
              </span>
            </header>

            {!info.enabled && (
              <div className="provider-off-note">{t("provider_off_banner")}</div>
            )}

            {info.id === "vertex" ? (
              <div className="provider-fields">
                <div className="settings-vertex-grid">
                  <div>
                    <label htmlFor="settings-project">{t("settings_project")}</label>
                    <input
                      id="settings-project"
                      value={project}
                      placeholder="my-gcp-project-id"
                      readOnly={remote}
                      onChange={(e) => setProject(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="settings-location">{t("settings_location")}</label>
                    <input
                      id="settings-location"
                      value={location}
                      placeholder="global"
                      readOnly={remote}
                      onChange={(e) => setLocation(e.target.value)}
                    />
                  </div>
                </div>
                <div className="settings-callout">{t("settings_adc_hint")}</div>
              </div>
            ) : (
              <div className="provider-fields">
                <div className="provider-key-field">
                  <span className="provider-field-label">{t("gemini_api_key")}</span>
                  {source === "env" ? (
                    <div className="provider-key-env">
                      <Icon name="check" size="sm" />
                      {t("gemini_key_set_by_env")}
                    </div>
                  ) : keyStorage === "env_only" ? (
                    <div className="provider-key-env provider-key-locked">
                      <Icon name="lock" size="sm" />
                      {t("gemini_key_env_only_note")}
                    </div>
                  ) : source === "saved" && !replacingKey ? (
                    <div className="provider-key-saved">
                      <Icon name="check" size="sm" />
                      <span>
                        {last4
                          ? t("gemini_key_saved", { last4 })
                          : t("gemini_key_saved_plain")}
                      </span>
                      {!remote && (
                        <>
                          <Button size="sm" onClick={() => setReplacingKey(true)}>
                            {t("gemini_key_replace")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="provider-key-remove"
                            disabled={saving}
                            onClick={() => void removeKey()}
                          >
                            {t("gemini_key_remove")}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : (
                    <input
                      type="password"
                      value={keyInput}
                      placeholder={t("gemini_key_placeholder")}
                      autoFocus={replacingKey}
                      readOnly={remote || keyStorage === "env_only"}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                  )}
                  {showKeyInput && replacingKey && (
                    <button
                      type="button"
                      className="link-btn provider-key-cancel"
                      onClick={() => {
                        setReplacingKey(false);
                        setKeyInput("");
                      }}
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
                {keyStorage === "memory" && (
                  <div className="settings-callout">{t("gemini_key_memory_note")}</div>
                )}
                <div className="settings-callout">{t("gemini_storage_hint")}</div>
              </div>
            )}

            {err && <div className="notice error small">{err}</div>}

            {!remote && (
              <footer className="provider-detail-actions">
                <div className="provider-check-result" aria-live="polite">
                  {check && (
                    <span
                      className={
                        check.ok && expectedMissing.length === 0 ? "ok" : "warn"
                      }
                    >
                      <Icon
                        name={check.ok && expectedMissing.length === 0 ? "check" : "warning"}
                        size="sm"
                      />
                      {expectedMissing.length > 0
                        ? t("provider_check_missing", {
                            models: expectedMissing.join(", "),
                          })
                        : check.message}
                    </span>
                  )}
                </div>
                <Button disabled={checking} onClick={() => void runCheck()}>
                  {checking ? t("checking_connection") : t("check_connection")}
                </Button>
                <Button
                  variant="primary"
                  disabled={!canSave}
                  onClick={() => void save()}
                >
                  {saving ? t("saving") : t("save")}
                </Button>
              </footer>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
