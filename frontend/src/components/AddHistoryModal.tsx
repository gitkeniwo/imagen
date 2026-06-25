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
  const [outputImages, setOutputImages] = useState<ImageRow[]>(
    src?.outputImage ? [src.outputImage] : [],
  );
  const [outputNote, setOutputNote] = useState(src?.outputImage?.note ?? "");
  const [outputTagIds, setOutputTagIds] = useState<number[]>(
    (src?.outputImage?.tags ?? []).map((tg) => tg.id),
  );
  const [outputBusy, setOutputBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<"input" | "output" | null>(null);

  const isCreate = !existing;

  const addInputImage = (img: ImageRow) =>
    setInputImages((prev) => (prev.some((i) => i.id === img.id) ? prev : [...prev, img]));

  // Append an output image. In create mode multiple outputs are allowed
  // (each becomes its own record on save); in edit mode only one is kept.
  const addOutput = (img: ImageRow) => {
    setOutputImages((prev) => {
      if (prev.some((i) => i.id === img.id)) return prev;
      return isCreate ? [...prev, img] : [img];
    });
  };

  // Seed the shared note/tags from a newly added image, but only when the user
  // hasn't set any yet. This surfaces a picked image's metadata on first add
  // while preserving an existing selection when the output is swapped (e.g. on
  // duplicate, removing the inherited output and adding a replacement must not
  // wipe the inherited tags).
  const seedMetaIfEmpty = (img: ImageRow) => {
    if (outputNote.trim() !== "" || outputTagIds.length > 0) return;
    setOutputNote(img.note ?? "");
    setOutputTagIds((img.tags ?? []).map((tg) => tg.id));
  };

  // Re-seed the shared note/tags from a picked image (used when picking from
  // the library so the chosen image's existing note/tags are surfaced).
  const pickOutput = (img: ImageRow) => {
    addOutput(img);
    seedMetaIfEmpty(img);
  };

  const removeOutput = (id: number) => {
    setOutputImages((prev) => prev.filter((i) => i.id !== id));
  };

  const uploadOutput = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setOutputBusy(true);
    setErr(null);
    try {
      const { images } = await api.uploadImages(list);
      // Surface the first uploaded image's note/tags, unless the user already
      // has a selection (see seedMetaIfEmpty).
      if (images[0]) seedMetaIfEmpty(images[0]);
      images.forEach((im) => addOutput(im));
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

  // Apply the shared note/tags to a single output image.
  const applyNoteAndTags = async (img: ImageRow) => {
    const current = (img.tags ?? []).map((tg) => tg.id);
    const added = outputTagIds.filter((x) => !current.includes(x));
    const removed = current.filter((x) => !outputTagIds.includes(x));
    if (added.length) await api.batchTag([img.id], added, "add");
    if (removed.length) await api.batchTag([img.id], removed, "remove");
    const trimmedNote = outputNote.trim();
    if (trimmedNote !== (img.note ?? "")) {
      await api.patchImage(img.id, { note: trimmedNote });
    }
  };

  const save = async () => {
    const finalStatus: RealStatus | "note" = kind === "note" ? "note" : status;
    if (finalStatus === "success" && outputImages.length === 0) {
      setErr(t("add_history_need_output"));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const base = {
        prompt,
        model,
        aspectRatio,
        resolution,
        status: finalStatus,
        source: kind === "note" ? ("manual" as const) : kind,
        errorMessage: errorMessage.trim() || null,
        inputImageIds: inputImages.map((i) => i.id),
        createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      };
      if (existing) {
        const out = outputImages[0];
        await api.updateGeneration(existing.id, { ...base, outputImageId: out?.id ?? null });
        if (out) await applyNoteAndTags(out);
      } else {
        // Create: one record per output image (same prompt/inputs), so a batch
        // of N same-prompt outputs becomes N records. No output → one record.
        const targets = outputImages.length ? outputImages : [null];
        for (const out of targets) {
          await api.createManualGeneration({ ...base, outputImageId: out?.id ?? null });
          if (out) await applyNoteAndTags(out);
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
            {outputImages.map((im) => (
              <div className="chip" key={im.id} title={im.filename}>
                <img src={imgThumbUrl(im.id)} alt={im.filename} />
                <button className="x" onClick={() => removeOutput(im.id)}>
                  ×
                </button>
              </div>
            ))}
            {(isCreate || outputImages.length === 0) && (
              <label className="dropzone" style={{ cursor: "pointer" }}>
                {outputBusy ? <span className="spinner" /> : <span>{t("tray_upload")}</span>}
                <input
                  type="file"
                  accept="image/*"
                  multiple={isCreate}
                  hidden
                  onChange={(e) => {
                    uploadOutput(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          {(isCreate || outputImages.length === 0) && (
            <button
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => setPicker("output")}
            >
              <i className="fa-solid fa-images" /> {t("pick_from_library")}
            </button>
          )}
          {isCreate && outputImages.length > 1 && (
            <p className="muted small" style={{ marginTop: 6 }}>
              {t("batch_output_hint", { n: outputImages.length })}
            </p>
          )}
          {outputImages.length > 0 && (
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
          mode={picker === "input" || (picker === "output" && isCreate) ? "multi" : "single"}
          onPick={picker === "input" ? addInputImage : pickOutput}
          onClose={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
