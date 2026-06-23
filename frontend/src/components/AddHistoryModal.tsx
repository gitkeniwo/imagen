import { useState } from "react";
import { api, ASPECT_RATIOS, ImageRow, MODELS, RESOLUTIONS, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import CustomSelect from "./CustomSelect";
import LibraryPickerModal from "./LibraryPickerModal";
import ReferenceTray from "./ReferenceTray";

type Status = "success" | "blocked" | "error" | "note";
const STATUSES: Status[] = ["success", "blocked", "error", "note"];

export default function AddHistoryModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState(ASPECT_RATIOS[0]);
  const [resolution, setResolution] = useState(RESOLUTIONS[0]);
  const [status, setStatus] = useState<Status>("success");
  const [errorMessage, setErrorMessage] = useState("");
  const [createdAt, setCreatedAt] = useState("");
  const [inputImages, setInputImages] = useState<ImageRow[]>([]);
  const [outputImage, setOutputImage] = useState<ImageRow | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<"input" | "output" | null>(null);

  const addInputImage = (img: ImageRow) =>
    setInputImages((prev) => (prev.some((i) => i.id === img.id) ? prev : [...prev, img]));

  const uploadOutput = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setOutputBusy(true);
    setErr(null);
    try {
      const { images } = await api.uploadImages([files[0]]);
      setOutputImage(images[0]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOutputBusy(false);
    }
  };

  const moveInput = (from: number, to: number) => {
    setInputImages((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const save = async () => {
    if (status === "success" && !outputImage) {
      setErr(t("add_history_need_output"));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.createManualGeneration({
        prompt,
        model,
        aspectRatio,
        resolution,
        status,
        errorMessage: errorMessage.trim() || null,
        inputImageIds: inputImages.map((i) => i.id),
        outputImageId: outputImage?.id ?? null,
        createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      });
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
      <div
        className="modal"
        style={{ width: 640, maxHeight: "88vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("add_history_title")}</h3>
        <p className="muted small">{t("add_history_desc")}</p>

        <label>{t("prompt")}</label>
        <textarea
          value={prompt}
          placeholder={t("prompt_placeholder")}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div style={{ marginTop: 14 }}>
          <ReferenceTray
            tray={inputImages}
            onAdd={(imgs) => setInputImages((prev) => [...prev, ...imgs])}
            onRemove={(id) => setInputImages((prev) => prev.filter((i) => i.id !== id))}
            onMove={moveInput}
          />
          <button
            type="button"
            style={{ marginTop: 8 }}
            onClick={() => setPicker("input")}
          >
            <i className="fa-solid fa-images" /> {t("pick_from_library")}
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>{t("add_history_output")}</label>
          <div className="tray">
            {outputImage ? (
              <div className="chip" title={outputImage.filename}>
                <img src={imgThumbUrl(outputImage.id)} alt={outputImage.filename} />
                <button className="x" onClick={() => setOutputImage(null)}>
                  ×
                </button>
              </div>
            ) : (
              <label className="dropzone" style={{ cursor: "pointer" }}>
                {outputBusy ? <span className="spinner" /> : <span>{t("tray_upload")}</span>}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    uploadOutput(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          {!outputImage && (
            <button
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => setPicker("output")}
            >
              <i className="fa-solid fa-images" /> {t("pick_from_library")}
            </button>
          )}
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <div>
            <label>{t("model")}</label>
            <CustomSelect
              value={model}
              onChange={setModel}
              options={MODELS.map((m) => ({ id: m.id, label: m.label }))}
            />
          </div>
          <div>
            <label>{t("resolution")}</label>
            <div className="seg">
              {RESOLUTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={resolution === r ? "on" : ""}
                  onClick={() => setResolution(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>{t("aspect")}</label>
          <div className="aspect-row">
            {ASPECT_RATIOS.map((r) => {
              const [w, h] = r.split(":").map(Number);
              return (
                <button
                  key={r}
                  type="button"
                  className={`aspect-btn${aspectRatio === r ? " on" : ""}`}
                  onClick={() => setAspectRatio(r)}
                  title={r}
                >
                  <span className="aspect-shape" style={{ aspectRatio: `${w} / ${h}` }} />
                  <span className="aspect-label">{r}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>{t("add_history_status")}</label>
          <div className="seg">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? "on" : ""}
                onClick={() => setStatus(s)}
              >
                {t(`status_${s}`)}
              </button>
            ))}
          </div>
        </div>

        {(status === "blocked" || status === "error") && (
          <div style={{ marginTop: 14 }}>
            <label>{t("add_history_error_message")}</label>
            <textarea value={errorMessage} onChange={(e) => setErrorMessage(e.target.value)} />
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label>{t("add_history_created_at")}</label>
          <input
            type="datetime-local"
            value={createdAt}
            onChange={(e) => setCreatedAt(e.target.value)}
          />
        </div>

        {err && (
          <div className="notice error small" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}

        <div className="row" style={{ marginTop: 18 }}>
          <button onClick={onClose}>{t("cancel")}</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </div>
      {picker && (
        <LibraryPickerModal
          mode={picker === "input" ? "multi" : "single"}
          onPick={picker === "input" ? addInputImage : setOutputImage}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
