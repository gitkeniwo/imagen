import { useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  DEFAULT_MODEL,
  Draft,
  DraftBody,
  ImageRow,
  imgThumbUrl,
  providerOf,
  ProviderId,
} from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import LibraryPickerModal from "./LibraryPickerModal";
import OptionBar from "./OptionBar";
import ReferenceTray from "./ReferenceTray";
import TagPicker from "./TagPicker";
import Icon from "./ui/Icon";
import ImageViewer from "./ImageViewer";
import { downloadImage } from "./GenerationCard";
import { useToast } from "./Toast";
import { pressable } from "../a11y";
import { useContextMenu } from "./ui/ContextMenu";
import { Button, IconButton } from "./ui/Button";
import { useBackLayer } from "../backStack";
import { displayName } from "../displayName";

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
  const toast = useToast();
  const { open: openContextMenu } = useContextMenu();
  const [viewing, setViewing] = useState<ImageRow | null>(null);
  const [prompt, setPrompt] = useState(existing?.prompt ?? seed?.prompt ?? "");
  const { enabled: enabledProviders, spec: specOf } = useProviders();
  // A draft keeps its provider even if that provider is off; it can be
  // edited, just not queued (Drafts checks readiness per draft).
  const [provider, setProvider] = useState<ProviderId>(
    existing ? providerOf(existing) : seed?.provider ?? enabledProviders[0]?.id ?? "vertex",
  );
  const [model, setModel] = useState(existing?.model ?? seed?.model ?? DEFAULT_MODEL);
  const [aspectRatio, setAspectRatio] = useState(
    existing?.aspect_ratio ?? seed?.aspectRatio ?? "1:1",
  );
  const [resolution, setResolution] = useState(
    existing?.resolution ?? seed?.resolution ?? "1K",
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
  // Back rejects while the save is in flight, like the disabled Cancel button.
  useBackLayer(true, () => (saving ? false : onClose()));

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

  const removeOutput = (id: number) => setOutputs((prev) => prev.filter((x) => x.id !== id));

  // Output attachments only detach from the draft; the image stays in the
  // library, so removing needs no confirmation.
  const openOutputMenu = (img: ImageRow, trigger: HTMLElement, x: number, y: number) => {
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      quickActions: [
        { icon: "view", label: t("open_viewer"), onSelect: () => setViewing(img) },
        {
          icon: "favorite",
          label: img.starred ? t("favorited") : t("favorite"),
          ariaLabel: img.starred ? t("unfavorite") : t("favorite"),
          selected: !!img.starred,
          filled: !!img.starred,
          onSelect: async () => {
            const starred = img.starred ? 0 : 1;
            try {
              await api.patchImage(img.id, { starred: !!starred });
              setOutputs((prev) => prev.map((x) => (x.id === img.id ? { ...x, starred } : x)));
            } catch (e) {
              toast(t("op_failed", { msg: (e as Error).message }));
            }
          },
        },
        { icon: "download", label: t("download"), onSelect: () => downloadImage(img) },
      ],
      sections: [
        [
          {
            icon: "removeFromRefs",
            label: t("remove_from_outputs"),
            onSelect: () => removeOutput(img.id),
          },
        ],
      ],
      ariaLabel: t("image_menu"),
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
      provider,
      model,
      aspectRatio,
      resolution: specOf(provider, model)?.resolutions.length ? resolution : null,
      outputFormat: format,
      skipIfPrecedingSucceeds: skip,
      pinned,
      inputImageIds: inputs.map((img) => img.id),
      outputImageIds: outputs.map((img) => img.id),
      tagIds,
      seriesId: existing ? existing.series_id ?? null : seed?.seriesId ?? null,
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
        <h3 className="mt-0">{existing ? t("edit_draft") : t("new_draft")}</h3>
        <p className="muted small">{t("draft_editor_desc")}</p>

        <label>{t("prompt")}</label>
        <textarea
          autoFocus
          value={prompt}
          placeholder={t("prompt_placeholder")}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="mt-4">
          <ReferenceTray
            tray={inputs}
            onAdd={(images) => images.forEach((img) => addUnique(setInputs, img))}
            onRemove={(id) => setInputs((prev) => prev.filter((img) => img.id !== id))}
            onMove={moveInput}
          />
          <Button className="mt-2" icon="pickFromLibrary" onClick={() => setPicker("input")}>
            {t("pick_from_library")}
          </Button>
        </div>

        <div className="mt-4">
          <label>{t("draft_outputs")}</label>
          <p className="muted small draft-output-hint">{t("draft_outputs_hint")}</p>
          <div className="tray dropzone-wrap">
            {outputs.map((img) => (
              <div className="chip" key={img.id} title={displayName(img, t)}>
                <img
                  src={imgThumbUrl(img)}
                  alt={displayName(img, t)}
                  {...pressable(
                    () => setViewing(img),
                    (trigger, x, y) => openOutputMenu(img, trigger, x, y),
                  )}
                />
                <IconButton
                  className="x"
                  variant="overlay"
                  icon="close"
                  label={t("remove_ref")}
                  onClick={() => removeOutput(img.id)}
                />
              </div>
            ))}
            <label className="dropzone">
              {outputBusy ? <span className="spinner" /> : (
                <span className="dropzone-label">
                  <Icon name="upload" />
                  {t("tray_upload")}
                </span>
              )}
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
          <Button className="mt-2" icon="pickFromLibrary" onClick={() => setPicker("output")}>
            {t("pick_from_library")}
          </Button>
        </div>

        <div className="mt-4">
          <OptionBar
            provider={provider}
            model={model}
            setProvider={setProvider}
            setModel={setModel}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            resolution={resolution}
            setResolution={setResolution}
            format={format}
            setFormat={setFormat}
          />
        </div>

        <div className="mt-4">
          <label>{t("archive_to")}</label>
          <TagPicker selected={tagIds} onChange={setTagIds} />
        </div>

        <div className="draft-editor-toggles">
          <button
            className={`skip-toggle${skip ? " on" : ""}`}
            aria-pressed={skip}
            onClick={() => setSkip((v) => !v)}
          >
            {t("skip_if_preceding_succeeds")}
          </button>
          <Button
            className={`skip-toggle${pinned ? " on" : ""}`}
            icon="pin"
            aria-pressed={pinned}
            onClick={() => setPinned((v) => !v)}
          >
            {t("pin_draft")}
          </Button>
        </div>

        {err && <div className="notice error small mt-3">{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>{t("cancel")}</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? t("saving") : t("save_draft")}
          </button>
        </div>
      </div>

      {viewing && (
        <ImageViewer
          nested
          image={viewing}
          list={[viewing]}
          onClose={() => setViewing(null)}
          onAddToTray={(img) => addUnique(setInputs, img)}
          trayIds={inputs.map((img) => img.id)}
          onRemoveFromTray={(img) => setInputs((prev) => prev.filter((item) => item.id !== img.id))}
          onTagsChanged={() => {}}
        />
      )}

      {picker && (
        <LibraryPickerModal
          mode="multi"
          onPick={(img) => addUnique(picker === "input" ? setInputs : setOutputs, img)}
          pickedIds={(picker === "input" ? inputs : outputs).map((img) => img.id)}
          onUnpick={(img) =>
            (picker === "input" ? setInputs : setOutputs)((prev) => prev.filter((item) => item.id !== img.id))
          }
          onClose={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
