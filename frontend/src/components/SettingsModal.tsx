import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  isProviderId,
  LibraryInfo,
  ProviderId,
  settingsApi,
} from "../api";
import { useI18n } from "../i18n";
import Icon, { type IconName } from "./ui/Icon";
import { Button, IconButton } from "./ui/Button";
import Segmented from "./ui/Segmented";
import RemoteSettings from "./RemoteSettings";
import { useRemote } from "../remote";
import { useBackLayer } from "../backStack";
import ProvidersSettings from "./ProvidersSettings";
import RoleBadge from "./ui/RoleBadge";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import LibrarySwitching from "./LibrarySwitching";
import { shellAction } from "../shell";

type Section = "library" | "providers" | "prefs" | "remote" | "device";
export type SettingsSection =
  | Section
  | "vertex"
  | `providers:${ProviderId}`;

const SECTIONS: { id: Section; icon: IconName; label: string }[] = [
  { id: "library", icon: "libraryFolder", label: "settings_section_library" },
  { id: "providers", icon: "cloud", label: "settings_section_providers" },
  { id: "prefs", icon: "preferences", label: "settings_section_prefs" },
  { id: "remote", icon: "radio", label: "settings_section_remote" },
  { id: "device", icon: "tablet", label: "settings_section_device" },
];

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SettingsModal({
  onClose,
  onSaved,
  undoSeconds,
  setUndoSeconds,
  initialSection = "library",
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
  onSaved: () => void;
  undoSeconds: number;
  setUndoSeconds: (n: number) => void;
}) {
  const { t, lang, setLang } = useI18n();
  const { remote, hostName, device, role, signOut } = useRemote();
  const askConfirm = useConfirm();
  const toast = useToast();
  const initial = (() => {
    if (initialSection === "vertex" || initialSection.startsWith("providers")) {
      return {
        section: "providers" as const,
        provider: initialSection.includes(":")
          ? (initialSection.split(":")[1] as ProviderId)
          : undefined,
      };
    }
    return { section: initialSection as Section, provider: undefined };
  })();
  const [section, setSection] = useState<Section>(initial.section);
  // The menubar popover can ask for another section while the modal is already
  // open (window event -> App state). The prop only changes on that request.
  useEffect(() => {
    if (initialSection === "vertex" || initialSection.startsWith("providers")) {
      setSection("providers");
    } else {
      setSection(initialSection as Section);
    }
  }, [initialSection]);
  const [library, setLibrary] = useState<LibraryInfo | null>(null);
  // Set while the shell's native folder dialog is up; the page has no way to
  // hear about a cancel, so it clears when the window gets focus back.
  const [picking, setPicking] = useState(false);
  // Typed path, for people who don't know ⌘⇧G in the folder dialog. The shell
  // validates it and asks for confirmation in a native dialog.
  const [typing, setTyping] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const [switching, setSwitching] = useState<{ name: string; key: string } | null>(null);
  // A switch owns the page until it reloads. Returning false vetoes the
  // browser/iOS back gesture and keeps this history layer in place.
  useBackLayer(true, () => (switching ? false : onClose()));

  useEffect(() => {
    api.getLibrary().then(setLibrary).catch(() => setLibrary(null));
  }, []);

  // Escape closes, matching the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !switching) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, switching]);

  useEffect(() => {
    if (!picking) return;
    const done = () => window.setTimeout(() => setPicking(false), 400);
    window.addEventListener("focus", done);
    document.addEventListener("pointerdown", done);
    return () => {
      window.removeEventListener("focus", done);
      document.removeEventListener("pointerdown", done);
    };
  }, [picking]);

  const pick = (action: string) => {
    setPicking(true);
    shellAction(action);
  };

  const when = (secs: number | null) => {
    if (!secs) return "";
    const d = new Date(secs * 1000);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    if (days <= 0) return t("when_today");
    if (days === 1) return t("when_yesterday");
    if (days < 7) return t("when_days_ago", { n: days });
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const loadLibrary = async () => {
    try {
      setLibrary(await api.getLibrary());
    } catch {
      setLibrary(null);
    }
  };

  const switchRecent = async (recent: LibraryInfo["recent"][number]) => {
    if (!recent.id || !library) return;
    const ok = await askConfirm({
      title: t("library_switch_confirm_t", { name: recent.name }),
      message: t("library_switch_confirm_b"),
      confirmLabel: t("library_switch_confirm_ok"),
    });
    if (!ok) return;

    const send = async (force: boolean) => {
      try {
        await settingsApi.switchLibrary(recent.index, recent.id!, force);
        setSwitching({ name: recent.name, key: library.key });
        return true;
      } catch (error) {
        if (!(error instanceof ApiError)) {
          toast(t("library_switch_error", { msg: (error as Error).message }));
          return false;
        }
        if (error.detail === "library_changed") {
          await loadLibrary();
          toast(t("library_switch_changed"), "info");
          return false;
        }
        if (error.detail === "switch_pending") {
          toast(t("library_switch_pending"));
          return false;
        }
        if (error.detail === "busy" && !force) {
          const busy = error.data as {
            running?: number;
            running_by?: { device: string; n: number }[];
            queued_mac?: number;
          };
          const by = (busy.running_by ?? [])
            .map((item) => t("library_switch_busy_by", { device: item.device, n: item.n }))
            .join(t("library_switch_busy_join"));
          const proceed = await askConfirm({
            title: t("library_switch_confirm_t", { name: recent.name }),
            message: t("library_switch_busy_b", {
              running: busy.running ?? 0,
              by: by || "—",
              queued: busy.queued_mac ?? 0,
            }),
            confirmLabel: t("library_switch_cancel_and_go"),
            cancelLabel: t("library_switch_wait"),
            danger: true,
          });
          if (proceed) return send(true);
          return false;
        }
        toast(t("library_switch_error", { msg: error.message }));
        return false;
      }
    };

    await send(false);
  };

  // Remote devices get the device page instead of host-only management; the
  // host window shows the remote-access page only when the backend supports it.
  const sections = SECTIONS.filter((s) =>
    remote ? s.id !== "remote" : s.id === "device" ? false : s.id !== "remote" || library?.desktop,
  );
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings_title")}
      onClick={() => {
        if (!switching) onClose();
      }}
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav" aria-label={t("settings_title")}>
          <h2>{t("settings_title")}</h2>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              <Icon name={s.icon} size="sm" />
              {t(s.label)}
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <div className="settings-head">
            <h3>{t(current.label)}</h3>
            {remote && <RoleBadge role={role} />}
            <IconButton
              icon="close"
              size="md"
              label={t("close")}
              disabled={!!switching}
              onClick={onClose}
            />
          </div>

          {section === "library" && remote && role === "member" && (
            <div className="settings-body">
              <div className="rm-callout lock"><Icon name="lock" size="sm" /><span>{t("remote_lib_lock")}</span></div>
            </div>
          )}

          {section === "library" && remote && role === "admin" && (
            <div className="settings-body">
              <div className="settings-lib-card">
                <span className="settings-lib-icon"><Icon name="libraryFolder" /></span>
                <div className="settings-lib-text">
                  <span className="settings-lib-name">
                    {library?.name || "—"}
                    <span className="settings-lib-current">{t("settings_library_current")}</span>
                  </span>
                  {library && (
                    <span className="muted small">
                      {t("settings_library_summary", {
                        images: library.images,
                        history: library.history,
                        size: fmtBytes(library.bytes),
                      })}
                    </span>
                  )}
                  <span className="muted small">
                    {t("remote_library_path_hidden", { host: hostName })}
                  </span>
                </div>
              </div>

              <div className="settings-group">
                <h4>{t("library_switch_recent")}</h4>
                <div className="settings-recent settings-recent-admin">
                  {library?.recent.map((recent) => (
                    <div
                      key={recent.index}
                      className={`settings-recent-row${recent.exists ? "" : " missing"}`}
                    >
                      <Icon name="libraryFolder" size="sm" />
                      <span className="settings-recent-text">
                        <span>{recent.name}</span>
                        <span className="muted small">
                          {recent.exists ? when(recent.opened_at) : t("library_recent_missing")}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        disabled={!recent.exists || !recent.id}
                        onClick={() => void switchRecent(recent)}
                      >
                        {t("library_switch")}
                      </Button>
                    </div>
                  ))}
                  {library && library.recent.length === 0 && (
                    <p className="muted small m-0 settings-note">{t("library_switch_no_recent")}</p>
                  )}
                </div>
              </div>
              <div className="rm-callout lock">
                <Icon name="lock" size="sm" />
                <span>{t("remote_library_admin_note")}</span>
              </div>
            </div>
          )}

          {section === "library" && !remote && (
            <div className="settings-body">
              <div className="settings-lib-card">
                <span className="settings-lib-icon"><Icon name="libraryFolder" /></span>
                <div className="settings-lib-text">
                  <span className="settings-lib-name">
                    {library?.name || "—"}
                    <span className="settings-lib-current">{t("settings_library_current")}</span>
                  </span>
                  <span className="settings-mono" title={library?.path}>{library?.path ?? "—"}</span>
                  {library && (
                    <span className="muted small">
                      {t("settings_library_summary", {
                        images: library.images,
                        history: library.history,
                        size: fmtBytes(library.bytes),
                      })}
                    </span>
                  )}
                </div>
                {library?.desktop && (
                  <Button size="sm" onClick={() => shellAction("reveal-library")}>
                    {t("settings_reveal_library")}
                  </Button>
                )}
              </div>

              {library?.desktop ? (
                <>
                  <div className="settings-group">
                    <h4>{t("settings_switch_library")}</h4>
                    <div className="settings-options">
                      <button type="button" className="settings-option" disabled={picking} onClick={() => pick("open-library")}>
                        <Icon name="openFolder" />
                        <span>
                          <b>{t("library_open_existing")}</b>
                          <span className="muted small">{t("library_open_existing_desc")}</span>
                        </span>
                      </button>
                      <button type="button" className="settings-option" disabled={picking} onClick={() => pick("create-library")}>
                        <Icon name="newFolder" />
                        <span>
                          <b>{t("library_create")}</b>
                          <span className="muted small">{t("library_create_desc")}</span>
                        </span>
                      </button>
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      className="settings-link"
                      aria-expanded={typing}
                      onClick={() => setTyping((v) => !v)}
                    >
                      {t("library_path_toggle")}
                    </Button>
                    {typing && (
                      <form
                        className="settings-path"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!typedPath.trim()) return;
                          pick(`open-path?p=${encodeURIComponent(typedPath)}`);
                        }}
                      >
                        <input
                          className="settings-mono"
                          aria-label={t("library_open_existing")}
                          placeholder={t("library_path_placeholder")}
                          value={typedPath}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          autoComplete="off"
                          autoFocus
                          onChange={(e) => setTypedPath(e.target.value)}
                        />
                        <Button type="submit" variant="primary" disabled={picking || !typedPath.trim()}>
                          {t("library_path_open")}
                        </Button>
                      </form>
                    )}
                    {picking && (
                      <div className="settings-status" role="status">
                        <span className="spinner" />
                        {t("settings_library_picking")}
                      </div>
                    )}
                  </div>

                  {library.recent.length > 0 && (
                    <div className="settings-group">
                      <h4>{t("library_recent")}</h4>
                      <div className="settings-recent">
                        {library.recent.map((r) => (
                          <div key={r.index} className="settings-recent-row">
                            <Icon name="libraryFolder" size="sm" />
                            <span className="settings-recent-text">
                              <span>{r.name}</span>
                              <span className="settings-mono" title={r.path}>{r.path}</span>
                            </span>
                            <span className="muted small">
                              {r.exists ? when(r.opened_at) : t("library_recent_missing")}
                            </span>
                            <Button
                              size="sm"
                              disabled={!r.exists || picking}
                              onClick={() => shellAction(`open-recent/${r.index}`)}
                            >
                              {t("library_recent_open")}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="muted small m-0 settings-note">{t("settings_library_switch_note")}</p>
                </>
              ) : (
                <p className="muted small m-0 settings-note">{t("settings_library_desktop_only")}</p>
              )}
            </div>
          )}

          {section === "providers" && (
            <ProvidersSettings
              initialProvider={
                initial.provider && isProviderId(initial.provider)
                  ? initial.provider
                  : undefined
              }
              onSaved={onSaved}
            />
          )}

          {section === "prefs" && (
            <div className="settings-body settings-prefs">
              <div className="settings-pref-row">
                <span className="settings-pref-label">{t("settings_language")}</span>
                <Segmented
                  value={lang}
                  onChange={setLang}
                  options={[
                    { value: "zh", label: "中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </div>
              <div className="settings-pref-row">
                <span className="settings-pref-label">
                  {t("undo_send_seconds")}
                  <span className="muted small">{t("undo_send_seconds_hint")}</span>
                </span>
                <div className="settings-stepper">
                  <IconButton
                    icon="remove"
                    label="−"
                    disabled={undoSeconds <= 0}
                    onClick={() => setUndoSeconds(Math.max(0, undoSeconds - 1))}
                  />
                  <input
                    type="number"
                    min={0}
                    max={60}
                    aria-label={t("undo_send_seconds")}
                    value={undoSeconds}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setUndoSeconds(Math.min(60, Math.max(0, Math.round(v))));
                    }}
                  />
                  <IconButton
                    icon="add"
                    label="+"
                    disabled={undoSeconds >= 60}
                    onClick={() => setUndoSeconds(Math.min(60, undoSeconds + 1))}
                  />
                </div>
              </div>
              <p className="muted small m-0">{t("settings_prefs_instant")}</p>
              {remote && <p className="muted small m-0">{t("remote_prefs_note")}</p>}
            </div>
          )}

          {section === "remote" && !remote && <RemoteSettings />}

          {section === "device" && remote && (
            <div className="settings-body">
              <div className="rm-card">
                <span className="rm-card-icon"><Icon name="tablet" /></span>
                <div className="rm-card-text">
                  <span className="rm-card-title">
                    {device?.name ?? t("remote_device_this")}
                    <span className="rm-chip ok"><span className="rm-dot" />{t("remote_connected")}</span>
                  </span>
                  <span className="muted small">{t("remote_on_host", { host: hostName })}</span>
                  {device && (
                    <span className="muted small">
                      {t("remote_signed_in_line", { date: new Date(device.created_at * 1000).toLocaleDateString() })}
                    </span>
                  )}
                </div>
              </div>
              <div className="rm-card rm-device-role">
                <span className="rm-card-icon"><Icon name="shield" /></span>
                <div className="rm-card-text">
                  <span className="rm-card-title">{t("remote_menu_role")}</span>
                  <span className="muted small">
                    {role === "admin" ? t("remote_admin_help") : t("remote_member_help")}
                  </span>
                </div>
                <RoleBadge role={role} />
              </div>
              <p className="muted small m-0">
                {t(role === "admin" ? "remote_signed_in_admin_d" : "remote_signed_in_d")}
              </p>
              <p className="muted small m-0">{t("remote_queue_note")}</p>
              <div className="settings-actions">
                <Button icon="logout" onClick={() => void signOut()}>{t("remote_sign_out_this")}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {switching && (
        <LibrarySwitching
          name={switching.name}
          hostName={hostName}
          previousKey={switching.key}
        />
      )}
    </div>
  );
}
