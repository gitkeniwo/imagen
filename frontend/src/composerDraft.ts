// Client-only composer workspaces (prompt + settings + reference image ids).
//
// Every workspace has its own localStorage record so two windows editing two
// tabs never overwrite each other. The index and the last-active ids are shared
// per library; the window's current workspace lives in sessionStorage.

import { DEFAULT_MODEL, isProviderId, OUTPUT_FORMATS, ProviderId } from "./api";
import { uuid } from "./uuid";

export interface ComposerDraft {
  id: string;
  prompt: string;
  inputIds: number[];
  // Records saved before providers existed have none; sanitizeDraft fills it.
  provider: ProviderId;
  model: string;
  aspectRatio: string;
  resolution: string;
  format: string;
  tagIds: number[];
  skipIfPrecedingSucceeds: boolean;
  updatedAt: number;
}

export interface WorkspaceRecord extends ComposerDraft {
  number: number;
  name: string | null;
}

export interface LoadedWorkspaces {
  workspaces: WorkspaceRecord[];
  lastId: string | null;
}

export type ComposerStorageEntry =
  | { kind: "index" }
  | { kind: "last" }
  | { kind: "active" }
  | { kind: "workspace"; id: string };

interface LegacyComposerStore {
  version: 1;
  activeId: string;
  workspaces: ComposerDraft[];
}

export const WORKSPACE_LIMIT = 12;
export const WORKSPACE_NAME_LIMIT = 40;

const V1_PREFIX = "imagen-composer:v1:";
const V2_PREFIX = "imagen-composer:v2:";
const VERSION = 2 as const;
const DEFAULT_PROVIDER: ProviderId = "vertex";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_RESOLUTION = "1K";
const DEFAULT_FORMAT = "image/jpeg";

const v1Key = (libraryKey: string) => `${V1_PREFIX}${libraryKey}`;
const libraryPrefix = (libraryKey: string) => `${V2_PREFIX}${libraryKey}`;
export const workspaceIndexKey = (libraryKey: string) =>
  `${libraryPrefix(libraryKey)}:index`;
export const workspaceKey = (libraryKey: string, id: string) =>
  `${libraryPrefix(libraryKey)}:ws:${id}`;
const lastKey = (libraryKey: string) => `${libraryPrefix(libraryKey)}:last`;
const activeKey = (libraryKey: string) => `${libraryPrefix(libraryKey)}:active`;
const workspaceKeyPrefix = (libraryKey: string) =>
  `${libraryPrefix(libraryKey)}:ws:`;

export function parseComposerStorageKey(
  libraryKey: string,
  key: string | null,
): ComposerStorageEntry | null {
  if (!key) return null;
  if (key === workspaceIndexKey(libraryKey)) return { kind: "index" };
  if (key === lastKey(libraryKey)) return { kind: "last" };
  if (key === activeKey(libraryKey)) return { kind: "active" };
  const prefix = workspaceKeyPrefix(libraryKey);
  if (key.startsWith(prefix)) {
    const id = key.slice(prefix.length);
    return id ? { kind: "workspace", id } : null;
  }
  return null;
}

export function hasLocalStorage(): boolean {
  try {
    const key = "__imagen_composer_probe__";
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function emptyDraft(): ComposerDraft {
  return {
    id: uuid(),
    prompt: "",
    inputIds: [],
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    resolution: DEFAULT_RESOLUTION,
    format: DEFAULT_FORMAT,
    tagIds: [],
    skipIfPrecedingSucceeds: false,
    updatedAt: Date.now(),
  };
}

/** An empty workspace, optionally copying another workspace's settings. */
export function emptyWorkspace(
  number = 1,
  settings?: Partial<ComposerDraft>,
): WorkspaceRecord {
  return {
    ...emptyDraft(),
    provider: settings?.provider ?? DEFAULT_PROVIDER,
    model: settings?.model ?? DEFAULT_MODEL,
    aspectRatio: settings?.aspectRatio ?? DEFAULT_ASPECT_RATIO,
    resolution: settings?.resolution ?? DEFAULT_RESOLUTION,
    format: settings?.format ?? DEFAULT_FORMAT,
    tagIds: settings?.tagIds ? [...settings.tagIds] : [],
    skipIfPrecedingSucceeds: settings?.skipIfPrecedingSucceeds ?? false,
    number,
    name: null,
  };
}

function positiveIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (
      typeof item === "number" &&
      Number.isInteger(item) &&
      item > 0 &&
      !seen.has(item)
    ) {
      seen.add(item);
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

function isLegacyStore(value: unknown): value is LegacyComposerStore {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.activeId === "string" &&
    Array.isArray(s.workspaces) &&
    s.workspaces.length > 0 &&
    s.workspaces.every(isDraft)
  );
}

/**
 * Coerce persisted values to something the UI can render. Only the shape is
 * checked here: whether the provider is on and serves this model/ratio is
 * decided once the provider catalog loads (App), so a slow catalog can't
 * reset a saved choice.
 */
export function sanitizeDraft(draft: ComposerDraft): ComposerDraft {
  return {
    ...draft,
    inputIds: positiveIds(draft.inputIds),
    provider: isProviderId(draft.provider) ? draft.provider : DEFAULT_PROVIDER,
    model: draft.model || DEFAULT_MODEL,
    aspectRatio: /^\d+:\d+$/.test(draft.aspectRatio)
      ? draft.aspectRatio
      : DEFAULT_ASPECT_RATIO,
    resolution: draft.resolution || DEFAULT_RESOLUTION,
    format: OUTPUT_FORMATS.some((f) => f.id === draft.format)
      ? draft.format
      : DEFAULT_FORMAT,
    tagIds: positiveIds(draft.tagIds),
    updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : Date.now(),
  };
}

export function sanitizeWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return [...trimmed].slice(0, WORKSPACE_NAME_LIMIT).join("");
}

export function sanitizeWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
  return {
    ...sanitizeDraft(workspace),
    number:
      Number.isInteger(workspace.number) && workspace.number > 0
        ? workspace.number
        : 1,
    name: sanitizeWorkspaceName(workspace.name),
  };
}

export function nextWorkspaceNumber(workspaces: WorkspaceRecord[]): number {
  const used = new Set(workspaces.map((workspace) => workspace.number));
  let number = 1;
  while (used.has(number)) number += 1;
  return number;
}

/** Keep valid unique numbers; fill invalid/duplicate ones in list order. */
export function repairWorkspaceNumbers(
  workspaces: WorkspaceRecord[],
): WorkspaceRecord[] {
  const used = new Set<number>();
  const repairAt: number[] = [];
  const next = workspaces.map((workspace, index) => {
    const number = workspace.number;
    if (Number.isInteger(number) && number > 0 && !used.has(number)) {
      used.add(number);
      return workspace;
    }
    repairAt.push(index);
    return workspace;
  });

  let candidate = 1;
  for (const index of repairAt) {
    while (used.has(candidate)) candidate += 1;
    used.add(candidate);
    next[index] = { ...next[index], number: candidate };
  }
  return next;
}

function parseIndex(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== VERSION || !Array.isArray(value.order)) return [];
    const order = value.order;
    return order.filter(
      (id, index): id is string =>
        typeof id === "string" &&
        id !== "" &&
        order.indexOf(id) === index,
    );
  } catch (err) {
    console.warn("[composer] ignoring an invalid workspace index", err);
    return [];
  }
}

function writeIndex(libraryKey: string, order: string[]): boolean {
  try {
    localStorage.setItem(
      workspaceIndexKey(libraryKey),
      JSON.stringify({ version: VERSION, order }),
    );
    return true;
  } catch (err) {
    console.warn("[composer] could not save the workspace index", err);
    return false;
  }
}

function readWorkspaceKeys(libraryKey: string): string[] {
  const prefix = workspaceKeyPrefix(libraryKey);
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
  } catch (err) {
    console.warn("[composer] could not scan saved workspaces", err);
  }
  return ids;
}

function readWorkspace(
  libraryKey: string,
  id: string,
): WorkspaceRecord | null {
  try {
    const raw = localStorage.getItem(workspaceKey(libraryKey, id));
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!isDraft(value)) return null;
    const record = value as ComposerDraft & {
      number?: unknown;
      name?: unknown;
    };
    return sanitizeWorkspace({
      ...record,
      id,
      number: typeof record.number === "number" ? record.number : 0,
      name: typeof record.name === "string" ? record.name : null,
    });
  } catch (err) {
    console.warn(`[composer] could not read workspace ${id}`, err);
    return null;
  }
}

export function readStoredWorkspace(
  libraryKey: string,
  id: string,
): WorkspaceRecord | null {
  return readWorkspace(libraryKey, id);
}

function migrateV1(libraryKey: string): LoadedWorkspaces | null {
  try {
    const raw = localStorage.getItem(v1Key(libraryKey));
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn("[composer] ignoring an invalid v1 draft", err);
      return null;
    }
    if (!isLegacyStore(parsed)) {
      console.warn("[composer] ignoring an invalid v1 draft");
      return null;
    }
    const active =
      parsed.workspaces.find((draft) => draft.id === parsed.activeId) ??
      parsed.workspaces[0];
    const workspace: WorkspaceRecord = {
      ...sanitizeDraft(active),
      number: 1,
      name: null,
    };
    localStorage.setItem(
      workspaceKey(libraryKey, workspace.id),
      JSON.stringify(workspace),
    );
    if (!writeIndex(libraryKey, [workspace.id])) return null;
    localStorage.removeItem(v1Key(libraryKey));
    return { workspaces: [workspace], lastId: workspace.id };
  } catch (err) {
    console.warn("[composer] could not migrate the v1 draft", err);
    return null;
  }
}

/**
 * Load the indexed workspaces, repairing missing/orphan records and duplicate
 * numbers. Missing or unreadable storage degrades to a memory-only workspace.
 */
export function loadWorkspaces(libraryKey: string): LoadedWorkspaces {
  let order: string[] | null = null;
  let indexRaw: string | null = null;
  try {
    indexRaw = localStorage.getItem(workspaceIndexKey(libraryKey));
    order = parseIndex(indexRaw);
  } catch (err) {
    console.warn("[composer] could not read the workspace index", err);
  }

  if (order === null) {
    const migrated = migrateV1(libraryKey);
    if (migrated) return migrated;
    order = [];
  }

  const storedIds = readWorkspaceKeys(libraryKey);
  const indexed = new Set(order);
  const orphanIds = storedIds.filter((id) => !indexed.has(id));
  if (orphanIds.length > 0) {
    console.warn(
      "[composer] appending unindexed workspace records",
      orphanIds.join(", "),
    );
  }
  const ids = [...order];
  for (const id of storedIds) {
    if (!indexed.has(id)) {
      ids.push(id);
      indexed.add(id);
    }
  }

  let repaired = indexRaw === null;
  const workspaces: WorkspaceRecord[] = [];
  for (const id of ids) {
    const workspace = readWorkspace(libraryKey, id);
    if (workspace) workspaces.push(workspace);
    else {
      console.warn(`[composer] removing missing workspace ${id}`);
      repaired = true;
    }
  }
  if (workspaces.length === 0) {
    workspaces.push(emptyWorkspace(1));
    repaired = true;
  }

  const numbered = repairWorkspaceNumbers(workspaces);
  if (
    numbered.some(
      (workspace, index) => workspace.number !== workspaces[index].number,
    )
  ) {
    console.warn("[composer] repaired duplicate or invalid workspace numbers");
    repaired = true;
  }

  if (
    repaired ||
    numbered.length !== order.length ||
    numbered.some((workspace, index) => workspace.id !== order[index])
  ) {
    for (const workspace of numbered) {
      try {
        localStorage.setItem(
          workspaceKey(libraryKey, workspace.id),
          JSON.stringify(workspace),
        );
      } catch (err) {
        console.warn("[composer] could not repair a saved workspace", err);
        break;
      }
    }
    writeIndex(
      libraryKey,
      numbered.map((workspace) => workspace.id),
    );
  }

  let lastId: string | null = null;
  try {
    const rawLast = localStorage.getItem(lastKey(libraryKey));
    if (rawLast && numbered.some((workspace) => workspace.id === rawLast)) {
      lastId = rawLast;
    }
  } catch {
    // Memory-only mode.
  }
  return { workspaces: numbered, lastId };
}

/** Best-effort record write; private mode / a full quota stays in memory. */
export function saveWorkspace(
  libraryKey: string,
  workspace: WorkspaceRecord,
): void {
  try {
    localStorage.setItem(
      workspaceKey(libraryKey, workspace.id),
      JSON.stringify(sanitizeWorkspace(workspace)),
    );
  } catch (err) {
    console.warn("[composer] could not save the workspace", err);
  }
}

export function deleteWorkspaceRecord(libraryKey: string, id: string): void {
  try {
    localStorage.removeItem(workspaceKey(libraryKey, id));
  } catch (err) {
    console.warn("[composer] could not delete the workspace", err);
  }
}

/**
 * Structure changes re-read the index before editing it, so a workspace added
 * by another window is not overwritten by this one.
 */
export function updateWorkspaceIndex(
  libraryKey: string,
  update: (order: string[]) => string[],
): string[] {
  let current: string[] = [];
  try {
    const raw = localStorage.getItem(workspaceIndexKey(libraryKey));
    current = parseIndex(raw) ?? [];
  } catch (err) {
    console.warn("[composer] could not re-read the workspace index", err);
  }
  const next = update([...current]).filter(
    (id, index, all) => id !== "" && all.indexOf(id) === index,
  );
  writeIndex(libraryKey, next);
  return next;
}

export function saveLastActiveId(libraryKey: string, id: string): void {
  try {
    localStorage.setItem(lastKey(libraryKey), id);
  } catch {
    // Memory-only mode.
  }
}

export function loadWindowActiveId(libraryKey: string): string | null {
  try {
    return sessionStorage.getItem(activeKey(libraryKey));
  } catch {
    return null;
  }
}

export function saveWindowActiveId(libraryKey: string, id: string): void {
  try {
    sessionStorage.setItem(activeKey(libraryKey), id);
  } catch {
    // Memory-only mode.
  }
}
