// Client-only draft of the composer (prompt + settings + reference image ids).
//
// Stored in localStorage per origin and per library. It is never sent to the
// backend: remote devices and the Mac each keep their own copy, and switching
// the desktop library switches the `libraryKey` namespace rather than mixing
// ids from two libraries.
//
// The store already holds a list of workspaces (plus `activeId`) even though
// this round always has exactly one: adding composer tabs later only means
// writing more entries, not migrating the format.

import { ASPECT_RATIOS, MODELS, OUTPUT_FORMATS, RESOLUTIONS } from "./api";
import { uuid } from "./uuid";

export interface ComposerDraft {
  id: string;
  prompt: string;
  inputIds: number[];
  model: string;
  aspectRatio: string;
  resolution: string;
  format: string;
  tagIds: number[];
  skipIfPrecedingSucceeds: boolean;
  updatedAt: number;
}

export interface ComposerStore {
  version: 1;
  activeId: string;
  workspaces: ComposerDraft[];
}

const KEY_PREFIX = "imagen-composer:v1:";
const VERSION = 1 as const;
const DEFAULT_MODEL = MODELS[0].id;
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_RESOLUTION = "1K";
const DEFAULT_FORMAT = "image/jpeg";

const storageKey = (libraryKey: string) => `${KEY_PREFIX}${libraryKey}`;

export function emptyDraft(): ComposerDraft {
  return {
    id: uuid(),
    prompt: "",
    inputIds: [],
    model: DEFAULT_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    resolution: DEFAULT_RESOLUTION,
    format: DEFAULT_FORMAT,
    tagIds: [],
    skipIfPrecedingSucceeds: false,
    updatedAt: Date.now(),
  };
}

export function emptyStore(): ComposerStore {
  const draft = emptyDraft();
  return { version: VERSION, activeId: draft.id, workspaces: [draft] };
}

function positiveIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      out.push(item);
    }
  }
  return out;
}

function isDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    d.id !== "" &&
    typeof d.prompt === "string" &&
    Array.isArray(d.inputIds) &&
    typeof d.model === "string" &&
    typeof d.aspectRatio === "string" &&
    typeof d.resolution === "string" &&
    typeof d.format === "string" &&
    Array.isArray(d.tagIds) &&
    typeof d.skipIfPrecedingSucceeds === "boolean" &&
    typeof d.updatedAt === "number"
  );
}

function isStore(value: unknown): value is ComposerStore {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === VERSION &&
    typeof s.activeId === "string" &&
    Array.isArray(s.workspaces) &&
    s.workspaces.length > 0 &&
    s.workspaces.every(isDraft)
  );
}

/** Coerce persisted values to something the UI can render. */
export function sanitizeDraft(draft: ComposerDraft): ComposerDraft {
  const model = MODELS.some((m) => m.id === draft.model)
    ? draft.model
    : DEFAULT_MODEL;
  return {
    ...draft,
    inputIds: positiveIds(draft.inputIds),
    model,
    aspectRatio: ASPECT_RATIOS.includes(draft.aspectRatio)
      ? draft.aspectRatio
      : DEFAULT_ASPECT_RATIO,
    resolution: RESOLUTIONS.includes(draft.resolution)
      ? draft.resolution
      : DEFAULT_RESOLUTION,
    format: OUTPUT_FORMATS.some((f) => f.id === draft.format)
      ? draft.format
      : DEFAULT_FORMAT,
    tagIds: positiveIds(draft.tagIds),
    updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : Date.now(),
  };
}

/**
 * Read the active draft for a library. Missing, unreadable, malformed, or
 * wrong-version data yields an empty store (with one console warning); this
 * never throws and never shows a toast.
 */
export function loadStore(libraryKey: string): ComposerStore {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(storageKey(libraryKey));
    if (raw === null) return emptyStore();
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[composer] could not read the saved draft", err);
    return emptyStore();
  }
  if (!isStore(parsed)) {
    console.warn("[composer] ignoring an invalid saved draft");
    return emptyStore();
  }
  const active =
    parsed.workspaces.find((draft) => draft.id === parsed.activeId) ??
    parsed.workspaces[0];
  const draft = sanitizeDraft(active);
  return { version: VERSION, activeId: draft.id, workspaces: [draft] };
}

/** Best-effort write; private mode / a full quota degrades to memory-only. */
export function saveStore(libraryKey: string, store: ComposerStore): void {
  try {
    localStorage.setItem(storageKey(libraryKey), JSON.stringify(store));
  } catch (err) {
    console.warn("[composer] could not save the draft", err);
  }
}
