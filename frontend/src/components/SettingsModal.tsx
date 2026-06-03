import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";

export default function SettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
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
    <div className="overlay" onClick={onClose}>
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
