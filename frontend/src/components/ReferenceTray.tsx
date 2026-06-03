import { useRef, useState } from "react";
import { api, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

export default function ReferenceTray({
  tray,
  onAdd,
  onRemove,
  onMove,
}: {
  tray: ImageRow[];
  onAdd: (imgs: ImageRow[]) => void;
  onRemove: (id: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useI18n();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setBusy(true);
    setErr(null);
    try {
      const { images } = await api.uploadImages(list);
      onAdd(images);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label>{t("tray_label")}</label>
      <div
        className={`tray dropzone-wrap${drag ? " drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        {tray.map((img, i) => (
          <div
            key={img.id}
            className="chip"
            draggable
            onDragStart={() => (dragIdx.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx.current !== null && dragIdx.current !== i) {
                onMove(dragIdx.current, i);
              }
              dragIdx.current = null;
            }}
            title={img.filename}
          >
            <img src={imgThumbUrl(img.id)} alt={img.filename} />
            <span className="pos">{i + 1}</span>
            <button className="x" onClick={() => onRemove(img.id)}>
              ×
            </button>
          </div>
        ))}
        <div
          className={`dropzone${drag ? " drag" : ""}`}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? <span className="spinner" /> : <span>{t("tray_upload")}</span>}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {err && <div className="notice error small" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
