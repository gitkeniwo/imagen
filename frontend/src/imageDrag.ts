import type { DragEvent as ReactDragEvent } from "react";
import type { ImageRow } from "./api";

// Dragging an image that already lives in the library (library grid, history
// outputs) carries the row itself under a private type, never the thumbnail
// file, so dropping it on a reference tray works like "Pick from library"
// instead of uploading a copy of the thumbnail.
export const IMAGE_MIME = "application/x-imagen-image";

export function isFileDrag(dt: DataTransfer | null) {
  return !!dt && Array.from(dt.types).includes("Files");
}

export function isImageDrag(dt: DataTransfer | null) {
  return !!dt && Array.from(dt.types).includes(IMAGE_MIME);
}

export function isRefDrag(dt: DataTransfer | null) {
  return isFileDrag(dt) || isImageDrag(dt);
}

export function readImageDrag(dt: DataTransfer): ImageRow | null {
  try {
    const raw = dt.getData(IMAGE_MIME);
    return raw ? (JSON.parse(raw) as ImageRow) : null;
  } catch {
    return null;
  }
}

// Spread on the element that should start the drag; its <img> must be
// `draggable={false}` so the browser never attaches the image file.
export function imageDragProps(img: ImageRow) {
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(IMAGE_MIME, JSON.stringify(img));
      const thumb = e.currentTarget.querySelector("img");
      if (thumb) e.dataTransfer.setDragImage(thumb, thumb.width / 2, thumb.height / 2);
    },
  };
}
