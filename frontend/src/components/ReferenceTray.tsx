import { useCallback, useEffect, useRef, useState } from "react";
import { api, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";

function isFileDrag(dataTransfer: DataTransfer | null) {
  return !!dataTransfer && Array.from(dataTransfer.types).includes("Files");
}

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
  const [pageDrag, setPageDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);

  const upload = useCallback(async (files: FileList | File[]) => {
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
  }, [onAdd]);

  // Use a counter pattern for reliable drag enter/leave detection.
  // Every child element fires its own dragenter/dragleave, so a simple
  // boolean flickers. The counter stays positive while the drag is anywhere
  // inside the window, and only hits 0 when the pointer truly leaves.
  const dragCounter = useRef(0);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounter.current++;
      if (dragCounter.current === 1) setPageDrag(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (_e: DragEvent) => {
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setPageDrag(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setPageDrag(false);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <div>
      {pageDrag && (
        <div
          className="file-drop-overlay"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            // Dismiss if the pointer exits this overlay (= leaves the window
            // or moves to a non-child element outside). The counter handles
            // the cross-element noise, but this provides the safety net for
            // the overlay itself.
            if (e.currentTarget === e.target) {
              dragCounter.current = 0;
              setPageDrag(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter.current = 0;
            setPageDrag(false);
            setDrag(false);
            if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
          }}
        >
          <div className="file-drop-box">
            <strong>{t("tray_drop_title")}</strong>
            <span>{t("tray_drop_hint")}</span>
          </div>
        </div>
      )}
      <label>{t("tray_label")}</label>
      <div
        className={`tray dropzone-wrap${drag ? " drag" : ""}`}
        onDragOver={(e) => {
          if (!isFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!isFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setDrag(false);
          setPageDrag(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        {tray.map((img, i) => (
          <div
            key={img.id}
            className="chip"
            draggable
            onDragStart={(e) => {
              dragIdx.current = i;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx.current !== null && dragIdx.current !== i) {
                onMove(dragIdx.current, i);
              }
              dragIdx.current = null;
            }}
            title={img.filename}
          >
            <img src={imgThumbUrl(img.id)} alt={img.filename} draggable={false} />
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
