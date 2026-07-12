import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("global");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getVertex().then((v) => {
      if (v.project) setProject(v.project);
      if (v.location) setLocation(v.location);
    });
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t("settings_title")}</h3>
        <p className="muted small">{t("settings_desc")}</p>

        <label>{t("settings_project")}</label>
        <input
          value={project}
          placeholder="my-gcp-project-id"
          onChange={(e) => setProject(e.target.value)}
          autoFocus
        />

        <label style={{ marginTop: 12 }}>{t("settings_location")}</label>
        <input
          value={location}
          placeholder="global"
          onChange={(e) => setLocation(e.target.value)}
        />

        <p className="muted small" style={{ marginTop: 12 }}>
          {t("settings_adc_hint")}
        </p>

        <label style={{ marginTop: 12 }}>{t("undo_send_seconds")}</label>
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
        <p className="muted small" style={{ marginTop: 6 }}>
          {t("undo_send_seconds_hint")}
        </p>

        {err && (
          <div className="notice error small" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}
        <div className="row" style={{ marginTop: 18 }}>
          <button onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={save}
            disabled={saving || !project.trim()}
          >
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
