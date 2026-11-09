import { type ImageRow, imgFileUrl } from "./api";
import { shellAction } from "./shell";

/**
 * Copy text without any Tauri JS.
 *
 * The async Clipboard API needs a secure context and (in WKWebView) a user
 * gesture. When it is unavailable, fall back to the legacy hidden-textarea
 * command. Callers show a toast if both paths fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }

  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Event the desktop shell dispatches after a `copy-image` action. */
const COPY_IMAGE_RESULT = "imagen:copy-image";
const COPY_IMAGE_TIMEOUT_MS = 10_000;

function inDesktopShell(): boolean {
  // Injected into every Tauri webview, including the backend-served page.
  return (window as Window & { isTauri?: boolean }).isTauri === true;
}

/**
 * Browser fallback: support varies by engine (Chromium only accepts PNG;
 * WebKit also takes JPEG), so unsupported originals fail cleanly instead of
 * being re-encoded. It always uses the original file URL, never the thumbnail.
 */
async function copyImageInBrowser(img: ImageRow): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      return false;
    }
    // Pass a pending blob: WebKit wants `write` itself inside the user
    // gesture, while the download may resolve later.
    const blob = fetch(imgFileUrl(img)).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    });
    // If `write` rejects before consuming the promise, the fetch failure must
    // not surface as an unhandled rejection.
    blob.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ [img.mime]: blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the underlying image file to the clipboard.
 *
 * The desktop page is a remote Tauri origin, so IPC is blocked by design. It
 * asks the shell through `imagen-action://copy-image/<id>` instead; the shell
 * reads the stored original (not the WebP thumbnail) and puts its exact bytes
 * on the pasteboard under the file's real type, so a JPEG stays a JPEG.
 */
export function copyImageToClipboard(img: ImageRow): Promise<boolean> {
  if (!inDesktopShell()) return copyImageInBrowser(img);

  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener(COPY_IMAGE_RESULT, onResult);
      resolve(ok);
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: number; ok?: boolean }>).detail;
      if (detail?.id !== img.id) return;
      finish(detail.ok === true);
    };
    const timer = window.setTimeout(() => finish(false), COPY_IMAGE_TIMEOUT_MS);
    window.addEventListener(COPY_IMAGE_RESULT, onResult);
    shellAction(`copy-image/${img.id}`);
  });
}
