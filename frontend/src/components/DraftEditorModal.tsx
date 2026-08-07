import { useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  ASPECT_RATIOS,
  Draft,
  DraftBody,
  ImageRow,
  MODELS,
  RESOLUTIONS,
  imgThumbUrl,
} from "../api";
import { useI18n } from "../i18n";
import LibraryPickerModal from "./LibraryPickerModal";
import OptionBar from "./OptionBar";
import ReferenceTray from "./ReferenceTray";
import TagPicker from "./TagPicker";

export default function DraftEditorModal({
  existing,
  seed,
  onClose,
  onSaved,
}: {
  existing?: Draft;
  seed?: Partial<DraftBody>;
  onClose: () => void;
  onSaved: (draft: Draft) => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState(existing?.prompt ?? seed?.prompt ?? "");
  const [model, setModel] = useState(existing?.model ?? seed?.model ?? MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState(
    existing?.aspect_ratio ?? seed?.aspectRatio ?? ASPECT_RATIOS[0],
  );
  const [resolution, setResolution] = useState(
    existing?.resolution ?? seed?.resolution ?? RESOLUTIONS[0],
  );
  const [format, setFormat] = useState(
    existing?.output_format ?? seed?.outputFormat ?? "image/jpeg",
  );
  const [skip, setSkip] = useState(
    !!existing?.skip_if_preceding_succeeds || !!seed?.skipIfPrecedingSucceeds,
  );
  const [pinned, setPinned] = useState(!!existing?.pinned || !!seed?.pinned);
  const [inputs, setInputs] = useState<ImageRow[]>(existing?.inputImages ?? []);
  const [outputs, setOutputs] = useState<ImageRow[]>(existing?.outputImages ?? []);
  const [tagIds, setTagIds] = useState<number[]>(
    existing?.tags.map((tag) => tag.id) ?? seed?.tagIds ?? [],
  );
  const [picker, setPicker] = useState<"input" | "output" | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addUnique = (setter: React.Dispatch<React.SetStateAction<ImageRow[]>>, img: ImageRow) =>
    setter((prev) => (prev.some((item) => item.id === img.id) ? prev : [...prev, img]));

  const moveInput = (from: number, to: number) => {
    setInputs((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const uploadOutputs = async (files: FileList | null) => {
    if (!files?.length) return;
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setOutputBusy(true);
    setErr(null);
    try {
      const result = await api.uploadImages(images);
      result.images.forEach((img) => addUnique(setOutputs, img));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOutputBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    const body: DraftBody = {
      prompt,
      model,
      aspectRatio,
      resolution: MODELS.find((item) => item.id === model)?.pro ? resolution : null,
      outputFormat: format,
      skipIfPrecedingSucceeds: skip,
      pinned,
      inputImageIds: inputs.map((img) => img.id),
      outputImageIds: outputs.map((img) => img.id),
      tagIds,
    };
    try {
      const draft = existing
        ? await api.updateDraft(existing.id, body)
        : await api.createDraft(body);
      onSaved(draft);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal draft-editor-modal" onPointerDown={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{existing ? t("edit_draft") : t("new_draft")}</h3>
        <p className="muted small">{t("draft_editor_desc")}</p>

        <label>{t("prompt")}</label>
        <textarea
          autoFocus
          value={prompt}
          placeholder={t("prompt_placeholder")}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div style={{ marginTop: 14 }}>
          <ReferenceTray
            tray={inputs}
            onAdd={(images) => images.forEach((img) => addUnique(setInputs, img))}
            onRemove={(id) => setInputs((prev) => prev.filter((img) => img.id !== id))}
            onMove={moveInput}
            noGlobalDrop
          />
          <button type="button" style={{ marginTop: 8 }} onClick={() => setPicker("input")}>
            <i className="fa-solid fa-images" /> {t("pick_from_library")}
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>{t("draft_outputs")}</label>
          <p className="muted small draft-output-hint">{t("draft_outputs_hint")}</p>
          <div className="tray dropzone-wrap">
            {outputs.map((img) => (
              <div className="chip" key={img.id} title={img.filename}>
                <img src={imgThumbUrl(img.id)} alt={img.filename} />
                <button className="x" onClick={() => setOutputs((prev) => prev.filter((x) => x.id !== img.id))}>×</button>
              </div>
            ))}
            <label className="dropzone" style={{ cursor: "pointer" }}>
              {outputBusy ? <span className="spinner" /> : <span>{t("tray_upload")}</span>}
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  uploadOutputs(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <button type="button" style={{ marginTop: 8 }} onClick={() => setPicker("output")}>
            <i className="fa-solid fa-images" /> {t("pick_from_library")}
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <OptionBar
            model={model}
            setModel={setModel}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            resolution={resolution}
            setResolution={setResolution}
            format={format}
            setFormat={setFormat}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <label>{t("archive_to")}</label>
          <TagPicker selected={tagIds} onChange={setTagIds} />
        </div>

        <div className="draft-editor-toggles">
          <button className={`skip-toggle${skip ? " on" : ""}`} onClick={() => setSkip((v) => !v)}>
            {t("skip_if_preceding_succeeds")}
          </button>
          <button className={`skip-toggle${pinned ? " on" : ""}`} onClick={() => setPinned((v) => !v)}>
            <i className="fa-solid fa-thumbtack" /> {t("pin_draft")}
          </button>
        </div>

        {err && <div className="notice error small" style={{ marginTop: 12 }}>{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>{t("cancel")}</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? t("saving") : t("save_draft")}
          </button>
        </div>
      </div>

      {picker && (
        <LibraryPickerModal
          mode="multi"
          onPick={(img) => addUnique(picker === "input" ? setInputs : setOutputs, img)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
