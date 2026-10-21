import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import Segmented from "./ui/Segmented";

export default function SettingsModal({
  onClose,
  onSaved,
  undoSeconds,
  setUndoSeconds,
}: {
  onClose: () => void;
  onSaved: () => void;
  undoSeconds: number;
  setUndoSeconds: (n: number) => void;
}) {
  const { t, lang, setLang } = useI18n();
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("global");
  const [library, setLibrary] = useState<{ path: string; desktop: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getVertex().then((v) => {
      if (v.project) setProject(v.project);
      if (v.location) setLocation(v.location);
    });
    api.getLibrary().then(setLibrary).catch(() => setLibrary(null));
  }, []);

  // Escape closes, matching the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.setVertex(project.trim(), location.trim() || "global");
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="mt-0">{t("settings_title")}</h3>

        <section className="settings-section">
          <h4>{t("settings_section_library")}</h4>
          <div className="library-path-row">
            <div className="library-path">
              {library ? library.path : "—"}
            </div>
            {library?.desktop && (
              <div className="library-path-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    window.location.href = "imagen-action://change-library";
                  }}
                >
                  {t("settings_change_library")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    window.location.href = "imagen-action://reveal-library";
                  }}
                >
                  {t("settings_reveal_library")}
                </Button>
              </div>
            )}
          </div>
          {library?.desktop && (
            <p className="muted small mt-1_5 mb-0">
              {t("settings_library_hint")}
            </p>
          )}
        </section>

        <section className="settings-section">
          <h4>{t("settings_section_vertex")}</h4>
          <label>{t("settings_project")}</label>
          <p className="muted small m-0 mb-1">{t("settings_desc")}</p>
          <input
            value={project}
            placeholder="my-gcp-project-id"
            onChange={(e) => setProject(e.target.value)}
            autoFocus
          />

          <label className="mt-3">{t("settings_location")}</label>
          <input
            value={location}
            placeholder="global"
            onChange={(e) => setLocation(e.target.value)}
          />

          <p className="muted small mt-3 mb-0">
            {t("settings_adc_hint")}
          </p>
        </section>

        <section className="settings-section">
          <h4>{t("settings_section_prefs")}</h4>
          <label>{t("settings_language")}</label>
          <Segmented
            className="settings-language"
            value={lang}
            onChange={setLang}
            options={[
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
          />

          <label className="mt-3">{t("undo_send_seconds")}</label>
          <input
            type="number"
            min={0}
            max={60}
            value={undoSeconds}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setUndoSeconds(Math.min(60, Math.max(0, Math.round(v))));
            }}
          />
          <p className="muted small mt-1_5 mb-0">
            {t("undo_send_seconds_hint")} {t("settings_prefs_instant")}
          </p>
        </section>

        {err && (
          <div className="notice error small mt-3">
            {err}
          </div>
        )}
        <div className="row mt-5">
          <button onClick={onClose}>{t("close")}</button>
          <button
            className="primary"
            onClick={save}
            disabled={saving || !project.trim()}
          >
            {saving ? t("saving") : t("settings_save_vertex")}
          </button>
        </div>
      </div>
    </div>
  );
}
