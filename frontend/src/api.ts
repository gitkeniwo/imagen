// Thin fetch wrapper around the FastAPI backend.

export interface TagRef {
  id: number;
  name: string;
  color: string | null;
}

export interface Tag extends TagRef {
  cover_image_id: number | null;
  count: number;
  created_at: string;
}

export interface ImageRow {
  id: number;
  filename: string;
  mime: string;
  width: number;
  height: number;
  byte_size?: number;
  source: "upload" | "generated";
  starred: number;
  note?: string | null;
  created_at: string;
  deleted_at?: string | null;
  tags?: TagRef[];
}

export interface Generation {
  id: number;
  prompt: string;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  status: "running" | "success" | "blocked" | "error" | "aborted" | "note";
  error_message: string | null;
  raw_finish: string | null;
  output_image_id: number | null;
  created_at: string;
  source: "vertex" | "manual";
  client_task_id: string | null;
  marker_color: MarkerColor | null;
  inputs?: ImageRow[];
  outputImage?: ImageRow | null;
}

export type MarkerColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";

export const MARKER_COLORS: Array<{ id: MarkerColor; hex: string }> = [
  { id: "red", hex: "#ef4444" },
  { id: "orange", hex: "#f97316" },
  { id: "yellow", hex: "#eab308" },
  { id: "green", hex: "#22c55e" },
  { id: "blue", hex: "#3b82f6" },
  { id: "purple", hex: "#8b5cf6" },
  { id: "pink", hex: "#ec4899" },
];

export type TaskStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "success"
  | "blocked"
  | "error"
  | "aborted";

// The durable, reusable part of a generation task. Composer, drafts and queue
// all exchange this shape so fields cannot silently drift between features.
export interface TaskSpec {
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string | null;
  format: string;
  inputs: ImageRow[];
  outputImages?: ImageRow[];
  tagIds: number[];
  skipIfPrecedingSucceeds?: boolean;
  markerColor?: MarkerColor | null;
}

// A client-side queued generation task (snapshot of the composer at submit time).
export interface QueueTask extends TaskSpec {
  id: string;
  status: TaskStatus;
  // When (ms epoch) this task may actually be dispatched to the backend. Until
  // then it sits in the "undo send" countdown window and can be cancelled with
  // a guaranteed no-charge (the request is never sent).
  dispatchAt: number;
  // Live backend phase while running (polled); undefined until first poll.
  phase?: TaskPhase;
  // Remote only: the connection dropped while this ran. The Mac keeps going;
  // the result is reconciled from history once the connection is back.
  interrupted?: boolean;
  message?: string | null;
  text?: string | null;
  rawFinish?: string | null;
  outputImage?: ImageRow | null;
}

export interface Draft {
  id: number;
  prompt: string;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  output_format: string;
  skip_if_preceding_succeeds: number;
  pinned: number;
  legacy_generation_id: number | null;
  created_at: string;
  updated_at: string;
  inputImages: ImageRow[];
  outputImages: ImageRow[];
  tags: TagRef[];
}

export interface DraftBody {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  outputFormat: string;
  skipIfPrecedingSucceeds: boolean;
  pinned?: boolean;
  inputImageIds: number[];
  outputImageIds: number[];
  tagIds: number[];
}

export const draftToTaskSpec = (draft: Draft): TaskSpec => ({
  prompt: draft.prompt,
  model: normalizeModelId(draft.model),
  aspectRatio: draft.aspect_ratio ?? "1:1",
  resolution: draft.resolution,
  format: draft.output_format,
  inputs: draft.inputImages,
  outputImages: draft.outputImages,
  tagIds: draft.tags.map((tag) => tag.id),
  skipIfPrecedingSucceeds: !!draft.skip_if_preceding_succeeds,
});

export interface GenerateResult {
  status: "success" | "blocked" | "error" | "aborted";
  message: string | null;
  text: string | null;
  generation: Generation | null;
  outputImage: ImageRow | null;
  inputImageIds: number[];
}

export interface GenerateBody {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  outputFormat: string;
  inputImageIds: number[];
  uploadImageIds: number[];
  tagIds?: number[];
  clientTaskId?: string;
  markerColor?: MarkerColor | null;
}

export interface ManualGenerationBody {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  status: "success" | "blocked" | "error";
  source: "vertex" | "manual";
  errorMessage?: string | null;
  inputImageIds: number[];
  outputImageId?: number | null;
  createdAt?: string | null;
}

// Live progress of an in-flight generation (polled while a task is running).
export interface TaskPhase {
  phase: "sent" | "retrying" | "unknown";
  attempt?: number;
  code?: number | null;
  delay?: number;
}

export interface CostBasisRow {
  model: string;
  resolution: string | null;
  count: number;
}

export type StatPeriod = "day" | "week" | "month" | "year" | "all";

export interface SeriesPoint {
  label: string;
  total: number;
  success: number;
  blocked: number;
  error: number;
  // Per-bucket success counts, so the chart tooltip can price a single bar.
  cost_basis: CostBasisRow[];
}

// All metrics for a single time window — the whole dashboard switches together.
export interface PeriodStats {
  total: number;
  by_status: Record<string, number>;
  by_model: Record<string, number>;
  cost_basis: CostBasisRow[];
  images: { total: number; by_source: Record<string, number>; bytes: number };
  chart: SeriesPoint[];
  // Most common blocked/error causes: `code` is a raw_finish the UI localizes;
  // `message` is the stored text when there is no code.
  failures: { code: string | null; message: string | null; count: number }[];
}

export interface Stats {
  periods: Record<StatPeriod, PeriodStats>;
  tags: number;
  first_at: string | null;
  last_at: string | null;
}

export const imgFileUrl = (id: number) => `/api/images/${id}/file`;
export const imgThumbUrl = (id: number) => `/api/images/${id}/thumb`;
export const batchDownloadUrl = (ids: number[]) =>
  `/api/images/batch-download?ids=${ids.join(",")}`;

const DOWNLOAD_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * User-facing download name, matching the backend Content-Disposition rule.
 * Keeps a valid existing extension (including .jpeg), otherwise appends or
 * replaces it from the image MIME. Colons in generated timestamps become
 * hyphens; the stored filename in the database is unchanged.
 */
export function downloadName(img: ImageRow): string {
  const ext = DOWNLOAD_EXT[(img.mime || "").toLowerCase()] ?? "png";
  const raw = (img.filename || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "") ?? "";
  if (!raw || raw === "." || raw === "..") {
    return `imagen-${img.id}.${ext}`;
  }

  const dot = raw.lastIndexOf(".");
  const suffix = dot > 0 ? raw.slice(dot + 1).toLowerCase() : "";
  const valid = ext === "jpg" ? ["jpg", "jpeg"] : [ext];
  let name: string;
  if (valid.includes(suffix)) {
    name = raw;
  } else if (dot > 0) {
    name = `${raw.slice(0, dot)}.${ext}`;
  } else {
    name = `${raw}.${ext}`;
  }
  return name.replace(/:/g, "-");
}

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
};

export const normalizeModelId = (model: string) => MODEL_ALIASES[model] ?? model;

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    // LAN session expired or was revoked on the Mac: back to the code page.
    if (res.status === 401 && detail === "remote_auth_required") {
      location.href = "/login";
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export interface VertexConfig {
  project: string | null;
  location: string;
  configured: boolean;
}

export interface LibraryInfo {
  path: string;
  name: string;
  desktop: boolean;
  images: number;
  bytes: number;
  history: number;
  // Desktop only: recently opened libraries (current one excluded). `index`
  // is the shell's own list position used by imagen-action://open-recent/<n>.
  recent: { index: number; path: string; name: string; opened_at: number | null; exists: boolean }[];
}

// Short-lived tags cache: Library/History/TagPicker all request /api/tags on
// mount and on every refresh, usually within the same second. The TTL is kept
// short because tag *counts* change as images are tagged/removed elsewhere.
let tagsCache: { at: number; promise: Promise<{ tags: Tag[] }> } | null = null;
const TAGS_CACHE_TTL_MS = 5000;

function invalidateTags() {
  tagsCache = null;
}

export const api = {
  async getVertex(): Promise<VertexConfig> {
    return handle(await fetch("/api/settings/vertex"));
  },
  async getLibrary(): Promise<LibraryInfo> {
    return handle(await fetch("/api/settings/library"));
  },
  async setVertex(project: string, location: string): Promise<VertexConfig> {
    return handle(
      await fetch("/api/settings/vertex", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, location }),
      }),
    );
  },
  async uploadImages(files: File[]): Promise<{ images: ImageRow[] }> {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return handle(await fetch("/api/images", { method: "POST", body: fd }));
  },
  async listImages(params: {
    limit?: number;
    offset?: number;
    source?: string;
    tag?: number;
    starred?: boolean;
    q?: string;
  } = {}): Promise<{ images: ImageRow[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.source) q.set("source", params.source);
    if (params.tag) q.set("tag", String(params.tag));
    if (params.starred) q.set("starred", "true");
    if (params.q && params.q.trim()) q.set("q", params.q.trim());
    return handle(await fetch(`/api/images?${q.toString()}`));
  },
  async patchImage(
    id: number,
    body: {
      starred?: boolean;
      filename?: string;
      note?: string;
      source?: "upload" | "generated";
    },
  ) {
    return handle(
      await fetch(`/api/images/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteImage(id: number) {
    return handle(await fetch(`/api/images/${id}`, { method: "DELETE" }));
  },
  async listBin(
    params: { limit?: number; offset?: number } = {},
  ): Promise<{ images: ImageRow[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return handle(await fetch(`/api/images/bin?${q.toString()}`));
  },
  async restoreImage(id: number) {
    return handle(await fetch(`/api/images/${id}/restore`, { method: "POST" }));
  },
  async purgeImage(id: number) {
    return handle(await fetch(`/api/images/${id}/purge`, { method: "DELETE" }));
  },
  async emptyBin(): Promise<{ purged: number }> {
    return handle(await fetch(`/api/images/bin/empty`, { method: "POST" }));
  },
  async generate(body: GenerateBody, signal?: AbortSignal): Promise<GenerateResult> {
    return handle(
      await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model: normalizeModelId(body.model) }),
        signal,
      }),
    );
  },
  async getProgress(cid: string): Promise<TaskPhase> {
    return handle(await fetch(`/api/generate/progress/${cid}`));
  },
  async cancelGenerate(cid: string): Promise<{ ok: boolean }> {
    return handle(
      await fetch(`/api/generate/cancel/${cid}`, { method: "POST" }),
    );
  },
  async updateGenerationMarker(cid: string, markerColor: MarkerColor | null) {
    return handle(
      await fetch(`/api/generations/by-client/${encodeURIComponent(cid)}/marker`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markerColor }),
      }),
    );
  },
  async getStats(): Promise<Stats> {
    return handle(await fetch("/api/stats"));
  },
  async listDrafts(
    params: { limit?: number; offset?: number; q?: string; pinned?: boolean } = {},
  ): Promise<{ drafts: Draft[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.q && params.q.trim()) q.set("q", params.q.trim());
    if (params.pinned !== undefined) q.set("pinned", String(params.pinned));
    return handle(await fetch(`/api/drafts?${q.toString()}`));
  },
  async createDraft(body: DraftBody): Promise<Draft> {
    return handle(
      await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async updateDraft(id: number, body: Partial<DraftBody>): Promise<Draft> {
    return handle(
      await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteDraft(id: number): Promise<{ deleted: number }> {
    return handle(await fetch(`/api/drafts/${id}`, { method: "DELETE" }));
  },
  async listGenerations(
    params: {
      limit?: number;
      offset?: number;
      tag?: number;
      q?: string;
      starred?: boolean;
      kind?: "vertex" | "manual";
      withOutput?: boolean;
    } = {},
  ): Promise<{ generations: Generation[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.tag) q.set("tag", String(params.tag));
    if (params.q && params.q.trim()) q.set("q", params.q.trim());
    if (params.starred) q.set("starred", "true");
    if (params.kind) q.set("kind", params.kind);
    if (params.withOutput) q.set("with_output", "true");
    return handle(await fetch(`/api/generations?${q.toString()}`));
  },
  async generationByOutput(imageId: number): Promise<Generation | null> {
    return handle(await fetch(`/api/generations/by-output/${imageId}`));
  },
  async createManualGeneration(body: ManualGenerationBody): Promise<Generation> {
    return handle(
      await fetch("/api/generations/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async updateGeneration(id: number, body: ManualGenerationBody): Promise<Generation> {
    return handle(
      await fetch(`/api/generations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async listTags(): Promise<{ tags: Tag[] }> {
    if (tagsCache && Date.now() - tagsCache.at < TAGS_CACHE_TTL_MS) {
      return tagsCache.promise;
    }
    const promise = fetch("/api/tags").then((res) => handle<{ tags: Tag[] }>(res));
    tagsCache = { at: Date.now(), promise };
    promise.catch(invalidateTags); // never cache a failure
    return promise;
  },
  async createTag(name: string, color?: string): Promise<Tag> {
    const tag = await handle<Tag>(
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      }),
    );
    invalidateTags();
    return tag;
  },
  async updateTag(
    id: number,
    body: { name?: string; color?: string; coverImageId?: number },
  ): Promise<Tag> {
    const tag = await handle<Tag>(
      await fetch(`/api/tags/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    invalidateTags();
    return tag;
  },
  async deleteTag(id: number) {
    const res = await handle(await fetch(`/api/tags/${id}`, { method: "DELETE" }));
    invalidateTags();
    return res;
  },
  async batchTag(imageIds: number[], tagIds: number[], op: "add" | "remove") {
    const res = await handle(
      await fetch("/api/tags/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageIds, tagIds, op }),
      }),
    );
    invalidateTags();
    return res;
  },
};

// Pro is first so it is the default selection.
export const MODELS = [
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (3 Pro)", pro: true },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (2.5 Flash)", pro: false },
];

export const ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];

export const RESOLUTIONS = ["1K", "2K", "4K"];

export const OUTPUT_FORMATS = [
  { id: "image/jpeg", label: "JPG" },
  { id: "image/png", label: "PNG" },
];

// Upper bound for "enqueue this task N times" (a retry group).
export const MAX_TASK_ATTEMPTS = 20;

// --- Remote (LAN) access ----------------------------------------------------

export interface SessionInfo {
  remote: boolean;
  host_name: string | null;
  device: { name: string; created_at: number } | null;
}

export interface RemoteAddress {
  iface: string;
  ip: string;
  kind: "wifi" | "ethernet" | "tailscale" | "other";
}

export interface RemoteDevice {
  id: string;
  name: string;
  ip: string;
  created_at: number;
  last_seen: number;
  active: boolean;
  running: number;
}

export type RemoteState = "off" | "idle" | "active" | "no_code" | "blocked";

export interface RemoteStatus {
  available: boolean;
  enabled: boolean;
  state: RemoteState;
  // blocked: firewall | port_in_use | no_network; off: too_many_attempts.
  reason: string | null;
  port: number;
  require_code: boolean;
  code: string | null;
  addresses: RemoteAddress[];
  local_name: string | null;
  host_name: string;
  devices: RemoteDevice[];
  // Open LAN (no code): someone is using it, but there are no sessions to list.
  anon_active: boolean;
  anon_running: number;
  failed_last_hour: number;
  keep_awake: boolean;
  awake_now: boolean;
  firewall: "ok" | "blocked" | "unknown";
}

export interface RemoteConfigPatch {
  enabled?: boolean;
  port?: number;
  require_code?: boolean;
  keep_awake?: boolean;
}

export type RemoteLoginResult =
  | { ok: true }
  | { ok: false; error: "wrong_code"; remaining: number }
  | { ok: false; error: "locked"; retryAfter: number }
  | { ok: false; error: "network" };

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const remoteApi = {
  async session(): Promise<SessionInfo> {
    return handle(await fetch("/api/session", { cache: "no-store" }));
  },
  async hello(): Promise<{ host_name: string; require_code: boolean }> {
    return handle(await fetch("/api/remote/hello", { cache: "no-store" }));
  },
  async login(code: string, name: string, remember: boolean): Promise<RemoteLoginResult> {
    let res: Response;
    try {
      res = await fetch("/api/remote/login", jsonInit("POST", { code, name, remember }));
    } catch {
      return { ok: false, error: "network" };
    }
    if (res.ok) return { ok: true };
    try {
      const body = await res.json();
      if (body.error === "wrong_code") {
        return { ok: false, error: "wrong_code", remaining: Number(body.remaining) || 0 };
      }
      if (body.error === "locked") {
        return { ok: false, error: "locked", retryAfter: Number(body.retry_after) || 60 };
      }
    } catch {
      /* fall through */
    }
    return { ok: false, error: "network" };
  },
  async logout(): Promise<void> {
    await handle(await fetch("/api/remote/logout", jsonInit("POST")));
  },
  // Host-only management calls (404 on the LAN listener).
  async status(): Promise<RemoteStatus> {
    return handle(await fetch("/api/remote/status", { cache: "no-store" }));
  },
  async configure(patch: RemoteConfigPatch): Promise<RemoteStatus> {
    return handle(await fetch("/api/remote/config", jsonInit("PUT", patch)));
  },
  async regenerateCode(): Promise<RemoteStatus> {
    return handle(await fetch("/api/remote/code/regenerate", jsonInit("POST")));
  },
  async signOutDevice(id: string): Promise<RemoteStatus> {
    return handle(await fetch(`/api/remote/sessions/${id}`, { method: "DELETE" }));
  },
  async signOutAll(): Promise<RemoteStatus> {
    return handle(await fetch("/api/remote/sessions", { method: "DELETE" }));
  },
};
