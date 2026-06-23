import { useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  ASPECT_RATIOS,
  Generation,
  ImageRow,
  MODELS,
  RESOLUTIONS,
  imgThumbUrl,
} from "../api";
import { useI18n } from "../i18n";
import CustomSelect from "./CustomSelect";
import LibraryPickerModal from "./LibraryPickerModal";
import ReferenceTray from "./ReferenceTray";
import TagPicker from "./TagPicker";

type Kind = "vertex" | "manual" | "note";
const KINDS: Kind[] = ["vertex", "manual", "note"];
type RealStatus = "success" | "blocked" | "error";
const REAL_STATUSES: RealStatus[] = ["success", "blocked", "error"];

function initialStatus(existing?: Generation): RealStatus {
  const s = existing?.status;
  return s === "success" || s === "blocked" || s === "error" ? s : "success";
}

// ISO timestamp -> value for <input type="datetime-local"> (local time, no tz).
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// Add or edit a manually-logged history record (or, in edit mode, any
// existing record). `existing` switches the modal into edit mode: fields are
// pre-filled and saving calls the update endpoint instead of create.
// `duplicate` pre-fills like edit mode but always creates a new record with the
// current timestamp (used to log a batch of outputs that share one prompt).
export default function AddHistoryModal({
  existing,
  duplicate,
  onClose,
  onSaved,
}: {
  existing?: Generation;
  duplicate?: Generation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  // Source record to pre-fill from: an explicit edit target, else a duplicate.
  // createdAt is only carried over in true edit mode, not when duplicating.
  const src = existing ?? duplicate;
  const [prompt, setPrompt] = useState(src?.prompt ?? "");
  const [model, setModel] = useState(src?.model ?? MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState(src?.aspect_ratio ?? ASPECT_RATIOS[0]);
  const [resolution, setResolution] = useState(src?.resolution ?? RESOLUTIONS[0]);
  const [kind, setKind] = useState<Kind>(
    src ? (src.status === "note" ? "note" : src.source) : "manual",
  );
  const [status, setStatus] = useState<RealStatus>(initialStatus(src));
  const [errorMessage, setErrorMessage] = useState(src?.error_message ?? "");
  const [createdAt, setCreatedAt] = useState(
    existing ? toLocalInputValue(existing.created_at) : "",
  );
  const [inputImages, setInputImages] = useState<ImageRow[]>(src?.inputs ?? []);
  const [outputImage, setOutputImage] = useState<ImageRow | null>(src?.outputImage ?? null);
  const [outputNote, setOutputNote] = useState(src?.outputImage?.note ?? "");
  const [outputTagIds, setOutputTagIds] = useState<number[]>(
    (src?.outputImage?.tags ?? []).map((tg) => tg.id),
  );
  const [outputBusy, setOutputBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<"input" | "output" | null>(null);

  const addInputImage = (img: ImageRow) =>
    setInputImages((prev) => (prev.some((i) => i.id === img.id) ? prev : [...prev, img]));

  const pickOutput = (img: ImageRow) => {
    setOutputImage(img);
    setOutputNote(img.note ?? "");
    setOutputTagIds((img.tags ?? []).map((tg) => tg.id));
  };

  const clearOutput = () => {
    setOutputImage(null);
    setOutputNote("");
    setOutputTagIds([]);
  };

  const uploadOutput = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setOutputBusy(true);
    setErr(null);
    try {
      const { images } = await api.uploadImages([files[0]]);
      pickOutput(images[0]);
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
    const finalStatus: RealStatus | "note" = kind === "note" ? "note" : status;
    if (finalStatus === "success" && !outputImage) {
      setErr(t("add_history_need_output"));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        prompt,
        model,
        aspectRatio,
        resolution,
        status: finalStatus,
        source: kind === "note" ? ("manual" as const) : kind,
        errorMessage: errorMessage.trim() || null,
        inputImageIds: inputImages.map((i) => i.id),
        outputImageId: outputImage?.id ?? null,
        createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      };
      if (existing) {
        await api.updateGeneration(existing.id, body);
      } else {
        await api.createManualGeneration(body);
      }
      if (outputImage) {
        const current = (outputImage.tags ?? []).map((tg) => tg.id);
        const added = outputTagIds.filter((x) => !current.includes(x));
        const removed = current.filter((x) => !outputTagIds.includes(x));
        if (added.length) await api.batchTag([outputImage.id], added, "add");
        if (removed.length) await api.batchTag([outputImage.id], removed, "remove");
        const trimmedNote = outputNote.trim();
        if (trimmedNote !== (outputImage.note ?? "")) {
          await api.patchImage(outputImage.id, { note: trimmedNote });
        }
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 640, maxHeight: "88vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          {existing ? t("edit_history_title") : t("add_history_title")}
        </h3>
        <p className="muted small">
          {existing ? t("edit_history_desc") : t("add_history_desc")}
        </p>

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
                <button className="x" onClick={clearOutput}>
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
          {outputImage && (
            <div style={{ marginTop: 10 }}>
              <label>{t("note_label")}</label>
              <textarea
                rows={2}
                value={outputNote}
                placeholder={t("note_placeholder")}
                onChange={(e) => setOutputNote(e.target.value)}
              />
              <label style={{ marginTop: 8 }}>{t("tags_label")}</label>
              <TagPicker selected={outputTagIds} onChange={setOutputTagIds} />
            </div>
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
          <label>{t("add_history_kind")}</label>
          <div className="seg">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={kind === k ? "on" : ""}
                onClick={() => setKind(k)}
              >
                {k === "vertex"
                  ? t("hist_filter_vertex")
                  : k === "manual"
                  ? t("hist_filter_manual")
                  : t("status_note")}
              </button>
            ))}
          </div>
        </div>

        {kind !== "note" && (
          <div style={{ marginTop: 14 }}>
            <label>{t("add_history_status")}</label>
            <div className="seg">
              {REAL_STATUSES.map((s) => (
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
        )}

        {kind !== "note" && (status === "blocked" || status === "error") && (
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
          onPick={picker === "input" ? addInputImage : pickOutput}
          onClose={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
