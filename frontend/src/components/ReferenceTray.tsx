import { useRemote } from "../remote";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import { peekProps } from "./HoverPeek";
import { isRefDrag, readImageDrag } from "../imageDrag";
import { Button, IconButton } from "./ui/Button";
import Menu from "./ui/Menu";

export default function ReferenceTray({
  tray,
  onAdd,
  onRemove,
  onMove,
  dropTarget,
  compact,
  onPickLibrary,
  onOpen,
  action,
  phone = false,
}: {
  tray: ImageRow[];
  onAdd: (imgs: ImageRow[]) => void;
  onRemove: (id: number) => void;
  onMove: (from: number, to: number) => void;
  // Element that takes drops from anywhere on the page (the composer card).
  // Without it only the tray itself accepts drops.
  dropTarget?: RefObject<HTMLElement | null>;
  // Composer layout: no label, small chips, inline upload / library buttons.
  compact?: boolean;
  onPickLibrary?: () => void;
  // Click a reference to open it in the viewer.
  onOpen?: (img: ImageRow) => void;
  // Shown at the right end of the label row (e.g. "Pick from library").
  action?: ReactNode;
  // Phone: 72px tiles and one "+ Add" menu instead of two text buttons.
  phone?: boolean;
}) {
  const { remote } = useRemote();
  const { t } = useI18n();
  const [drag, setDrag] = useState(false);
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

  const addDropped = (dt: DataTransfer) => {
    const img = readImageDrag(dt);
    if (img) onAdd([img]);
    else if (dt.files.length) upload(dt.files);
  };

  // Page-wide drag (composer only): everything but `dropTarget` is blurred and
  // refuses the drop; a dashed box over the target takes it. Dropping anywhere
  // else is cancelled (App's guard), so the webview never navigates to the file.
  // Every element fires its own dragenter/dragleave, so a counter tracks
  // whether the drag is still inside the window.
  const [hole, setHole] = useState<{ rect: DOMRect; radius: string } | null>(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    if (!dropTarget) return;
    const reset = () => {
      dragCounter.current = 0;
      setHole(null);
    };
    const onEnter = (e: DragEvent) => {
      if (!isRefDrag(e.dataTransfer)) return;
      dragCounter.current++;
      const el = dropTarget.current;
      if (dragCounter.current !== 1 || !el) return;
      el.scrollIntoView({ block: "nearest" });
      setHole({ rect: el.getBoundingClientRect(), radius: getComputedStyle(el).borderRadius });
    };
    const onLeave = () => {
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setHole(null);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("resize", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("resize", reset);
    };
  }, [dropTarget]);

  const pageDrop = hole && (() => {
    const { rect: r, radius } = hole;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Four blurred panes around the target, so the target itself stays sharp.
    const panes = [
      { left: 0, top: 0, width: vw, height: Math.max(0, r.top) },
      { left: 0, top: r.bottom, width: vw, height: Math.max(0, vh - r.bottom) },
      { left: 0, top: r.top, width: Math.max(0, r.left), height: r.height },
      { left: r.right, top: r.top, width: Math.max(0, vw - r.right), height: r.height },
    ];
    return createPortal(
      <>
        {panes.map((st, i) => (
          <div key={i} className="file-drop-scrim" style={st} />
        ))}
        <div
          className="file-drop-target"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height, borderRadius: radius }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragCounter.current = 0;
            setHole(null);
            addDropped(e.dataTransfer);
          }}
        >
          <span className="file-drop-pill">
            <Icon name="upload" size="sm" />
            {t("tray_drop_title")}
          </span>
        </div>
      </>,
      document.body,
    );
  })();

  return (
    <div>
      {pageDrop}
      {!compact && (
        <div className="field-head">
          <div className="field-title">
            <label>{t("tray_label")}</label>
            <span className="field-hint">{remote ? t("remote_ref_hint") : t("tray_label_hint")}</span>
          </div>
          {action}
        </div>
      )}
      <div
        className={`tray dropzone-wrap${compact ? " tray-compact" : ""}${phone ? " tray-phone" : ""}${drag ? " drag" : ""}`}
        onDragOver={(e) => {
          if (!isRefDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!isRefDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setDrag(false);
          addDropped(e.dataTransfer);
        }}
      >
        {tray.map((img, i) => (
          <div
            key={img.id}
            className={`chip${onOpen ? " openable" : ""}`}
            draggable
            {...peekProps(img, t("peek_ref", { n: i + 1 }))}
            onClick={(e) => {
              if (!onOpen || (e.target as HTMLElement).closest(".x")) return;
              onOpen(img);
            }}
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
          >
            <img src={imgThumbUrl(img.id)} alt={img.filename} draggable={false} />
            <span className="pos">{i + 1}</span>
            <IconButton
              className="x"
              variant="overlay"
              icon="close"
              label={t("remove_ref")}
              onClick={() => onRemove(img.id)}
            />
          </div>
        ))}
        {compact ? (
          phone ? (
            <Menu
              align="start"
              items={[
                {
                  icon: "upload",
                  label: t("upload_short"),
                  onSelect: () => fileInput.current?.click(),
                },
                ...(onPickLibrary
                  ? [{
                      icon: "pickFromLibrary" as const,
                      label: t("pick_from_library"),
                      onSelect: onPickLibrary,
                    }]
                  : []),
              ]}
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="tray-add"
                  aria-label={t("phone_add")}
                  aria-expanded={open}
                  disabled={busy}
                  onClick={toggle}
                >
                  {busy ? <span className="spinner" /> : <Icon name="add" />}
                  <span>{t("phone_add")}</span>
                </button>
              )}
            />
          ) : (
            <div className="tray-actions">
              <Button
                size="sm"
                icon="upload"
                title={t("tray_drop_hint")}
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy ? <span className="spinner" /> : t("upload_short")}
              </Button>
              {onPickLibrary && (
                <Button size="sm" icon="pickFromLibrary" onClick={onPickLibrary}>
                  {t("pick_from_library")}
                </Button>
              )}
              {tray.length === 0 && <span className="muted small">{t("tray_compact_hint")}</span>}
            </div>
          )
        ) : (
          <div
            className={`dropzone${drag ? " drag" : ""}`}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <span className="dropzone-label">
                <Icon name="upload" />
                {t("tray_upload")}
              </span>
            )}
          </div>
        )}
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
      {err && <div className="notice error small mt-2">{err}</div>}
    </div>
  );
}
