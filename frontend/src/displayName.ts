import type { ImageRow } from "./api";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// Generated images are stored as gen-<UTC ISO timestamp>.<ext>. Only that
// untouched default name is rewritten; a user-renamed image keeps its name.
const DEFAULT_GENERATED =
  /^gen-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)\.(?:jpe?g|png|webp|gif)$/i;

type NamedImage = Pick<ImageRow, "filename" | "source">;

export function isDefaultGeneratedName(img: NamedImage): boolean {
  return img.source === "generated" && DEFAULT_GENERATED.test(img.filename ?? "");
}

/** UTC time embedded in a default generated name, as a local Date. */
export function generatedDate(filename: string): Date | null {
  const match = DEFAULT_GENERATED.exec(filename ?? "");
  if (!match) return null;
  const date = new Date(`${match[1]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Month-day and local time to the second from a default generated name:
 * 11-05 19:24:13. Outputs finished within the same second share a name. */
export function generatedNameTime(filename: string): string | null {
  const date = generatedDate(filename);
  if (!date) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * User-facing image name. Library rows keep the raw filename, but an untouched
 * generated name becomes "Generated · 11-05 19:24:13" in the viewer, grid,
 * peeks and picker. The database value is never changed.
 */
export function displayName(img: Pick<ImageRow, "filename" | "source">, t: Translate): string {
  const time = isDefaultGeneratedName(img) ? generatedNameTime(img.filename) : null;
  return time ? t("generated_name", { time }) : img.filename;
}
