import { generatedDate, isDefaultGeneratedName } from "./displayName";

// Thin fetch wrapper around the FastAPI backend.

export type SeriesMark = "pick" | "reject";

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
  sha256?: string;
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
  // Set on History output thumbnails so the viewer can restore the exact grid
  // page even when the page also contains records without output images.
  generation_offset?: number;
  // Set on data scoped to one series (series-v2 marks).
  mark?: SeriesMark | null;
}

export interface Generation {
  id: number;
  prompt: string;
  // Missing on rows from an older backend: treat as "vertex" (providerOf).
  provider?: ProviderId;
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
  duration_ms: number | null;
  attempts: number | null;
  // Series the record is filed under (missing on an older backend).
  series_id?: number | null;
  inputs?: ImageRow[];
  outputImage?: ImageRow | null;
  generation_offset?: number;
  // Position in the distinct live-output-image sequence used by the viewer.
  output_index?: number;
  // Set when the API returns a record inside a series.
  mark?: SeriesMark | null;
}

// A later generation that used an image as one of its inputs (reverse
// lineage, GET /api/images/{id}/derived). `prompt` is capped server-side.
export interface DerivedGeneration {
  id: number;
  status: Generation["status"];
  prompt: string;
  promptTruncated: boolean;
  model: string;
  provider?: ProviderId;
  source: "vertex" | "manual";
  error_message: string | null;
  raw_finish: string | null;
  created_at: string;
  // null for blocked / failed / running records and purged outputs; an output
  // in the recycle bin keeps its row with `deleted_at` set.
  outputImage: ImageRow | null;
}

export interface DerivedPage {
  generations: DerivedGeneration[];
  total: number;
  limit: number;
  offset: number;
}

export type HistoryResult = "success" | "blocked" | "error";

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
  | "aborted"
  | "skipped";

// The durable, reusable part of a generation task. Composer, drafts and queue
// all exchange this shape so fields cannot silently drift between features.
export interface TaskSpec {
  prompt: string;
  provider: ProviderId;
  model: string;
  aspectRatio: string;
  resolution: string | null;
  format: string;
  inputs: ImageRow[];
  outputImages?: ImageRow[];
  tagIds: number[];
  skipIfPrecedingSucceeds?: boolean;
  markerColor?: MarkerColor | null;
  // Series the generation is filed under (null/undefined = none).
  seriesId?: number | null;
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
  durationMs?: number | null;
  attempts?: number | null;
  outputImage?: ImageRow | null;
}

export interface Draft {
  id: number;
  prompt: string;
  provider?: ProviderId;
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
  series_id?: number | null;
}

export interface DraftBody {
  prompt: string;
  provider: ProviderId;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  outputFormat: string;
  skipIfPrecedingSucceeds: boolean;
  pinned?: boolean;
  inputImageIds: number[];
  outputImageIds: number[];
  tagIds: number[];
  seriesId?: number | null;
}

export const draftToTaskSpec = (draft: Draft): TaskSpec => ({
  prompt: draft.prompt,
  provider: providerOf(draft),
  model: normalizeModelId(draft.model),
  aspectRatio: draft.aspect_ratio ?? "1:1",
  resolution: draft.resolution,
  format: draft.output_format,
  inputs: draft.inputImages,
  outputImages: draft.outputImages,
  tagIds: draft.tags.map((tag) => tag.id),
  skipIfPrecedingSucceeds: !!draft.skip_if_preceding_succeeds,
  seriesId: draft.series_id ?? null,
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
  provider: ProviderId;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  outputFormat: string;
  inputImageIds: number[];
  uploadImageIds: number[];
  tagIds?: number[];
  clientTaskId?: string;
  markerColor?: MarkerColor | null;
  seriesId?: number | null;
}

export interface ManualGenerationBody {
  prompt: string;
  provider: ProviderId;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  status: "success" | "blocked" | "error";
  source: "vertex" | "manual";
  errorMessage?: string | null;
  inputImageIds: number[];
  outputImageId?: number | null;
  createdAt?: string | null;
  // Omit on PATCH to keep the stored series; explicit null clears it.
  seriesId?: number | null;
}

// Live progress of an in-flight generation (polled while a task is running).
export interface TaskPhase {
  phase: "sent" | "retrying" | "unknown";
  attempt?: number;
  code?: number | null;
  delay?: number;
}

export interface CostBasisRow {
  provider: ProviderId;
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
  aborted: number;
  other: number;
  // Per-bucket success counts, so the chart tooltip can price a single bar.
  cost_basis: CostBasisRow[];
}

// All metrics for a single time window — the whole dashboard switches together.
export interface PeriodStats {
  total: number;
  by_status: Record<string, number>;
  by_model: Record<string, number>;
  by_provider: Record<string, number>;
  cost_basis: CostBasisRow[];
  images: { total: number; by_source: Record<string, number>; bytes: number };
  chart: SeriesPoint[];
  // Bucket unit chosen by the backend for this window (the "all" window picks
  // it from the actual data span).
  chart_unit: "hour" | "day" | "week" | "month" | "year";
  // Calendar bounds of this window; "all" uses the data span.
  range: { from: string; to: string } | null;
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

// Row IDs restart at 1 in every library, so the URL carries the content hash:
// an old library's cached bytes for the same ID can never be reused here.
type MediaRef = Pick<ImageRow, "id" | "sha256">;
const mediaVersion = (img: MediaRef) => (img.sha256 ?? "").slice(0, 16);
export const imgFileUrl = (img: MediaRef) => `/api/images/${img.id}/file?v=${mediaVersion(img)}`;
export const imgThumbUrl = (img: MediaRef) => `/api/images/${img.id}/thumb?v=${mediaVersion(img)}`;
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
  const generated = isDefaultGeneratedName(img) ? generatedDate(img.filename) : null;
  if (generated) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `imagen-${generated.getFullYear()}${pad(generated.getMonth() + 1)}${pad(generated.getDate())}-${pad(generated.getHours())}${pad(generated.getMinutes())}${pad(generated.getSeconds())}.${ext}`;
  }
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

// --- Providers --------------------------------------------------------------

export type ProviderId = "vertex" | "gemini";

export const PROVIDER_IDS: ProviderId[] = ["vertex", "gemini"];

export const isProviderId = (value: unknown): value is ProviderId =>
  PROVIDER_IDS.includes(value as ProviderId);

// Rows written before providers existed (or by an older backend) are Vertex.
export const providerOf = (row: { provider?: string | null }): ProviderId =>
  isProviderId(row.provider) ? row.provider : "vertex";

// One model as a provider serves it. Empty lists disable that control.
export interface ModelSpec {
  id: string;
  label: string;
  resolutions: string[];
  aspectRatios: string[];
  outputFormats: string[];
  // Formats produced by converting locally (the API itself can't return them).
  transcodes: string[];
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  // Non-secret, provider-specific. LAN devices get neither project nor keyLast4.
  detail: {
    project?: string | null;
    location?: string;
    keySource?: "env" | "saved" | null;
    keyLast4?: string | null;
    keyStorage?: string;
  };
  models: ModelSpec[];
}

export interface ProviderCheck {
  ok: boolean;
  message: string;
  models: string[];
  // Gemini only: whether each model's expected wire id is visible to the key.
  expected?: { id: string; wireId: string; found: boolean }[];
}

export class ApiError extends Error {
  detail: string;
  data: unknown;
  status: number;

  constructor(detail: string, data: unknown, status: number) {
    super(detail);
    this.name = "ApiError";
    this.detail = detail;
    this.data = data;
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    let data: unknown = null;
    try {
      data = await res.json();
      detail = (data as { detail?: string }).detail ?? detail;
    } catch {
      /* ignore */
    }
    // LAN session expired or was revoked on the Mac: back to the code page.
    if (res.status === 401 && detail === "remote_auth_required") {
      location.href = "/login";
    }
    throw new ApiError(detail, data, res.status);
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
  // Opaque per-library id (a path hash). Namespaces the local composer draft.
  key: string;
  // Desktop only: recently opened libraries (current one excluded). `index`
  // is the shell's own list position used by imagen-action://open-recent/<n>.
  recent: {
    index: number;
    path?: string;
    id?: string;
    name: string;
    opened_at: number | null;
    exists: boolean;
  }[];
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Short-lived tags cache: Library/History/TagPicker all request /api/tags on
// mount and on every refresh, usually within the same second. The TTL is kept
// short because tag *counts* change as images are tagged/removed elsewhere.
let tagsCache: { at: number; promise: Promise<{ tags: Tag[] }> } | null = null;
const TAGS_CACHE_TTL_MS = 5000;

function invalidateTags() {
  tagsCache = null;
}

// Filters shared by the Library list, its ids and its timeline.
export interface LibraryFilters {
  source?: string;
  tag?: number;
  starred?: boolean;
  q?: string;
}

export interface ImageTimeline {
  // Drafts: records pinned above the calendar section.
  pinned?: number;
  days: { day: string; count: number; first_index: number }[];
  // [start_index, day] wherever the day changes, in list order (first at 0).
  runs: [number, string][];
  total: number;
}

export interface GenerationFilters {
  tag?: number;
  q?: string;
  starred?: boolean;
  kind?: "vertex" | "manual";
  // Outcome: "error" also matches cancelled requests.
  status?: HistoryResult;
  model?: string;
  provider?: ProviderId;
  withOutput?: boolean;
  // A series id, or "none" for records outside every series.
  series?: number | "none";
}

export interface DraftFilters {
  q?: string;
}

function libraryFilterQuery(params: LibraryFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (params.source) q.set("source", params.source);
  if (params.tag) q.set("tag", String(params.tag));
  if (params.starred) q.set("starred", "true");
  if (params.q && params.q.trim()) q.set("q", params.q.trim());
  return q;
}

function generationFilterQuery(params: GenerationFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (params.tag) q.set("tag", String(params.tag));
  if (params.q && params.q.trim()) q.set("q", params.q.trim());
  if (params.starred) q.set("starred", "true");
  if (params.kind) q.set("kind", params.kind);
  if (params.status) q.set("status", params.status);
  if (params.model) q.set("model", params.model);
  if (params.provider) q.set("provider", params.provider);
  if (params.withOutput) q.set("with_output", "true");
  if (params.series !== undefined) q.set("series", String(params.series));
  return q;
}

function draftFilterQuery(params: DraftFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (params.q && params.q.trim()) q.set("q", params.q.trim());
  return q;
}

export const api = {
  async getProviders(): Promise<{ providers: ProviderInfo[] }> {
    return handle(await fetch("/api/providers", { cache: "no-store" }));
  },
  async setProviderEnabled(id: ProviderId, enabled: boolean): Promise<{ providers: ProviderInfo[] }> {
    return handle(await fetch(`/api/providers/${id}`, jsonInit("PUT", { enabled })));
  },
  async setGeminiKey(key: string): Promise<{ providers: ProviderInfo[] }> {
    return handle(await fetch("/api/providers/gemini/key", jsonInit("PUT", { key })));
  },
  async deleteGeminiKey(): Promise<{ providers: ProviderInfo[] }> {
    return handle(await fetch("/api/providers/gemini/key", { method: "DELETE" }));
  },
  async checkProvider(id: ProviderId): Promise<ProviderCheck> {
    return handle(await fetch(`/api/providers/${id}/check`, { method: "POST" }));
  },
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
  async listImages(
    params: LibraryFilters & { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ images: ImageRow[]; total: number }> {
    const q = libraryFilterQuery(params);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return handle(await fetch(`/api/images?${q.toString()}`, { signal }));
  },
  // Ids only, same filters and order as `listImages` (range / select-all).
  async listImageIds(
    params: LibraryFilters & { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ ids: number[]; total: number }> {
    const q = libraryFilterQuery(params);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return handle(await fetch(`/api/images/ids?${q.toString()}`, { signal }));
  },
  // Per-day counts; `first_index` is the day's first position in list order.
  async imageTimeline(params: LibraryFilters): Promise<ImageTimeline> {
    const q = libraryFilterQuery(params);
    q.set("tz", String(-new Date().getTimezoneOffset()));
    return handle(await fetch(`/api/images/timeline?${q.toString()}`));
  },
  // Restore saved composer references: live rows only, in the requested order.
  async lookupImages(ids: number[]): Promise<{ images: ImageRow[] }> {
    if (ids.length === 0) return { images: [] };
    return handle(await fetch(`/api/images/lookup?ids=${ids.join(",")}`));
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
    params: DraftFilters & { limit?: number; offset?: number; pinned?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ drafts: Draft[]; total: number }> {
    const q = draftFilterQuery(params);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.pinned !== undefined) q.set("pinned", String(params.pinned));
    return handle(await fetch(`/api/drafts?${q.toString()}`, { signal }));
  },
  async draftsTimeline(params: DraftFilters): Promise<ImageTimeline> {
    const q = draftFilterQuery(params);
    q.set("tz", String(-new Date().getTimezoneOffset()));
    return handle(await fetch(`/api/drafts/timeline?${q.toString()}`));
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
    params: GenerationFilters & {
      limit?: number;
      offset?: number;
      uniqueOutputs?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<{
    generations: Generation[];
    total: number;
    output_total: number;
    output_offset: number;
  }> {
    const q = generationFilterQuery(params);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.uniqueOutputs) q.set("unique_outputs", "true");
    return handle(await fetch(`/api/generations?${q.toString()}`, { signal }));
  },
  async generationTimeline(params: GenerationFilters): Promise<ImageTimeline> {
    const q = generationFilterQuery(params);
    q.set("tz", String(-new Date().getTimezoneOffset()));
    return handle(await fetch(`/api/generations/timeline?${q.toString()}`));
  },
  async listGenerationIds(
    params: GenerationFilters & { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ ids: number[]; total: number }> {
    const q = generationFilterQuery(params);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return handle(await fetch(`/api/generations/ids?${q.toString()}`, { signal }));
  },
  async derivedGenerations(imageId: number, offset = 0, limit = 24): Promise<DerivedPage> {
    return handle(await fetch(`/api/images/${imageId}/derived?offset=${offset}&limit=${limit}`));
  },
  async generationByOutput(imageId: number): Promise<Generation | null> {
    return handle(await fetch(`/api/generations/by-output/${imageId}`));
  },
  async getGeneration(id: number): Promise<Generation> {
    return handle(await fetch(`/api/generations/${id}`, { cache: "no-store" }));
  },
  // series-v2 B1a: every record that uses an image (output or input).
  async generationsByImage(imageId: number): Promise<{ generations: ImageUse[] }> {
    return handle(await fetch(`/api/generations/by-image/${imageId}`, { cache: "no-store" }));
  },
  async imageSeries(imageIds: number[]): Promise<{ items: { imageId: number; series: ImageSeriesEntry[] }[] }> {
    return handle(await fetch(`/api/generations/image-series?ids=${imageIds.join(",")}`, { cache: "no-store" }));
  },
  async seriesPositions(generationIds: number[]): Promise<{ items: SeriesPosition[] }> {
    return handle(await fetch(`/api/generations/series-position?ids=${generationIds.join(",")}`, { cache: "no-store" }));
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

// --- Series -------------------------------------------------------------------

export type SeriesKind = "theme" | "series";
export type SeriesStatus = "success" | "blocked" | "error" | "aborted";

export interface SeriesStats {
  tries: number;
  success: number;
  blocked: number;
  error: number;
  aborted: number;
  running: number;
  records: number;
  drafts: number;
  picks: number;
  last_at: string | null;
  // Most recent finished attempts, oldest first (status bar).
  strip: SeriesStatus[];
  // Collage: explicit cover, picks in series order, then newest successes.
  cover: ImageRow[];
}

export interface SeriesNode extends SeriesStats {
  id: number;
  kind: SeriesKind;
  parent_id: number | null;
  name: string;
  color: string | null;
  /** Explicit cover; null = automatic fallback. */
  cover_image_id: number | null;
  archived: number;
  created_at: string;
  updated_at: string;
  next_seq: number;
}

export interface ThemeNode extends SeriesNode {
  series: SeriesNode[];
}

export interface SeriesTree {
  themes: ThemeNode[];
  unthemed: SeriesNode[];
}

export interface SeriesDetail extends SeriesNode {
  theme: { id: number; name: string; color: string | null; archived: number } | null;
  outputs: { generation_id: number; image: ImageRow }[];
  /** Resolved cover (explicit or automatic). */
  cover_image: ImageRow | null;
}

export interface SeriesPrevious {
  id: number;
  seq: number;
  prompt: string;
  provider: ProviderId;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  status: Generation["status"];
  input_ids: number[];
}

export interface SeriesGeneration extends Generation {
  seq: number;
  previous: SeriesPrevious | null;
}

export interface SeriesTimeline {
  generations: SeriesGeneration[];
  total: number;
  counts: {
    all: number; success: number; blocked: number; error: number;
    picks: number; rejects: number;
  };
}

// series-v2 B3: versions = consecutive attempts with the same configuration.
export interface SeriesVersionParams {
  model: string | null;
  aspect_ratio: string | null;
  resolution: string | null;
  input_ids: number[];
}

export interface SeriesVersionAttempt {
  id: number;
  seq: number;
  status: Generation["status"];
  provider: ProviderId;
  source: Generation["source"];
  created_at: string;
  error_message: string | null;
  raw_finish: string | null;
  duration_ms: number | null;
  attempts: number | null;
  marker_color: MarkerColor | null;
  output_image_id: number | null;
  outputImage: ImageRow | null;
  mark: SeriesMark | null;
}

export type SeriesVersionParam = "model" | "aspect_ratio" | "resolution" | "inputs";

export interface SeriesVersion {
  version: number;
  key: string;
  first_seq: number;
  last_seq: number;
  prompt: string;
  params: SeriesVersionParams;
  changed_params: SeriesVersionParam[];
  prompt_changed: boolean;
  base_version: number | null;
  base_prompt: string | null;
  base_params: SeriesVersionParams | null;
  base_hidden: boolean;
  inputs: ImageRow[];
  /** Attempts left by the status filter, in series order (at most 200). */
  attempts: SeriesVersionAttempt[];
  attempts_total: number;
  counts: { all: number; success: number; blocked: number; error: number; aborted: number };
  hidden: boolean;
}

export interface SeriesVersions {
  versions: SeriesVersion[];
  total: number;
  next_cursor: number | null;
  order_custom: boolean;
}

// series-v2 B4: the whole series order (small) and the reorder endpoints.
export interface SeriesOrderItem {
  id: number;
  seq: number;
  version: number;
  /** Index into `SeriesOrder.keys` (the version configuration). */
  k: number;
  status: Generation["status"];
  created_at: string;
  output_image_id: number | null;
}

export interface SeriesOrder {
  items: SeriesOrderItem[];
  keys: string[];
  order_custom: boolean;
}

export interface SeriesReorderResult {
  order_custom: boolean;
  /** Every record whose #N changed, in new order. */
  changed: { id: number; seq: number; old_seq: number | null }[];
  /** reset only: the full order before, for Undo. */
  previous_order?: number[];
}

export interface SeriesImportPreview {
  tagId: number;
  found: number;
  inOtherSeries: number;
  failedSamePrompt: number;
  failedInOtherSeries: number;
  total: number;
}

// --- series-v2 B1a: series context of records and images ---------------------

/** One series an image belongs to. `role` = how that series' records use it. */
export interface ImageSeriesEntry {
  seriesId: number;
  generationId: number;
  role: "output" | "input";
  seq: number | null;
  total: number | null;
  /** vK of that record (series-v2 B3); missing on an older backend. */
  version?: number | null;
  /** This image's mark in that series, when it is an output. */
  mark?: SeriesMark | null;
}

/** A record's place in its series (#N · vK). */
export interface SeriesPosition {
  generationId: number;
  seriesId: number | null;
  seq: number | null;
  total: number | null;
  version: number | null;
  mark?: SeriesMark | null;
}

export interface ImageUse extends Omit<Generation, "inputs" | "outputImage"> {
  role: "output" | "input";
  seq: number | null;
}

export interface SeriesAssignBody {
  generationIds?: number[];
  draftIds?: number[];
  imageIds?: number[];
}

export interface SeriesPatch {
  name?: string;
  color?: string | null;
  parentId?: number | null;
  archived?: boolean;
  coverImageId?: number | null;
}

export type SeriesRecordFilter = HistoryResult | SeriesMark;

export const seriesApi = {
  async tree(archived: "0" | "1" | "all" = "all"): Promise<SeriesTree> {
    return handle(await fetch(`/api/series?archived=${archived}`, { cache: "no-store" }));
  },
  async get(id: number): Promise<SeriesDetail> {
    return handle(await fetch(`/api/series/${id}`, { cache: "no-store" }));
  },
  async create(body: {
    kind: SeriesKind;
    name: string;
    parentId?: number | null;
    color?: string | null;
  }): Promise<SeriesDetail> {
    return handle(await fetch("/api/series", jsonInit("POST", body)));
  },
  async update(id: number, patch: SeriesPatch): Promise<SeriesDetail> {
    return handle(await fetch(`/api/series/${id}`, jsonInit("PATCH", patch)));
  },
  async remove(id: number): Promise<{ deleted: number; movedSeries: number; clearedGenerations: number }> {
    return handle(await fetch(`/api/series/${id}`, { method: "DELETE" }));
  },
  async assign(
    id: number,
    body: SeriesAssignBody,
  ): Promise<{ generations: number; drafts: number; moved: number }> {
    return handle(await fetch(`/api/series/${id}/assign`, jsonInit("POST", body)));
  },
  async unassign(body: SeriesAssignBody): Promise<{ generations: number; drafts: number }> {
    return handle(await fetch("/api/series/unassign", jsonInit("POST", body)));
  },
  async timeline(
    id: number,
    params: { status?: SeriesRecordFilter; limit?: number; offset?: number } = {},
  ): Promise<SeriesTimeline> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return handle(await fetch(`/api/series/${id}/generations?${q.toString()}`, { cache: "no-store" }));
  },
  // series-v2 B3: the Changes view, paged by version (newest first).
  async versions(
    id: number,
    params: { status?: SeriesRecordFilter; cursor?: number | null; limit?: number } = {},
  ): Promise<SeriesVersions> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.cursor) q.set("cursor", String(params.cursor));
    if (params.limit) q.set("limit", String(params.limit));
    return handle(await fetch(`/api/series/${id}/versions?${q.toString()}`, { cache: "no-store" }));
  },
  // series-v2 B4: custom order.
  async order(id: number): Promise<SeriesOrder> {
    return handle(await fetch(`/api/series/${id}/order`, { cache: "no-store" }));
  },
  async reorder(
    id: number,
    body: { generationIds: number[]; before?: number; after?: number },
  ): Promise<SeriesReorderResult> {
    return handle(await fetch(`/api/series/${id}/reorder`, jsonInit("POST", body)));
  },
  async reorderReset(id: number): Promise<SeriesReorderResult> {
    return handle(await fetch(`/api/series/${id}/reorder/reset`, { method: "POST" }));
  },
  async reorderRestore(id: number, generationIds: number[]): Promise<SeriesReorderResult> {
    return handle(await fetch(`/api/series/${id}/reorder/restore`, jsonInit("POST", { generationIds })));
  },
  async setMark(
    id: number,
    imageId: number,
    kind: SeriesMark | null,
  ): Promise<{
    series_id: number;
    image_id: number;
    kind: SeriesMark | null;
    created_at: string | null;
  }> {
    return handle(await fetch(`/api/series/${id}/marks/${imageId}`, jsonInit("PUT", { kind })));
  },
  async clearPicks(id: number): Promise<{ cleared: number }> {
    return handle(await fetch(`/api/series/${id}/marks/clear`, jsonInit("POST", { kind: "pick" })));
  },
  async membership(
    imageIds: number[],
  ): Promise<{ items: { imageId: number; generationIds: number[]; seriesIds: number[] }[] }> {
    return handle(await fetch(`/api/series/membership?imageIds=${imageIds.join(",")}`));
  },
  async importPreview(tagId: number): Promise<SeriesImportPreview> {
    return handle(await fetch(`/api/series/import/preview?tag=${tagId}`));
  },
  async importFromTag(body: {
    tagId: number;
    name: string;
    parentId?: number | null;
    color?: string | null;
    includeFailed: boolean;
  }): Promise<{ series: SeriesDetail; assigned: number; preview: SeriesImportPreview }> {
    return handle(await fetch("/api/series/import", jsonInit("POST", body)));
  },
};

// The catalog (GET /api/providers) is the source of truth for what each model
// accepts. These are display fallbacks only: full names for tooltips, and
// labels for records whose provider is off or whose catalog hasn't loaded.
export const DEFAULT_MODEL = "gemini-3-pro-image";
// Shown while the catalog loads, so the option rows don't jump in later.
export const FALLBACK_ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];
export const FALLBACK_RESOLUTIONS = ["1K", "2K", "4K"];

export const MODEL_LABELS: Record<string, string> = {
  "gemini-3-pro-image": "Nano Banana Pro (3 Pro)",
  "gemini-2.5-flash-image": "Nano Banana (2.5 Flash)",
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  vertex: "Vertex AI",
  gemini: "Gemini API",
};

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
  role: "owner" | "admin" | "member";
  // Opaque current-library identity; lets the heartbeat detect library
  // changes without running the full library summary query.
  library_key?: string | null;
  device: {
    name: string;
    created_at: number;
    role?: "admin" | "member";
    role_since?: number | null;
    remember?: boolean;
  } | null;
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
  role: "admin" | "member";
  role_since: number | null;
  remember: boolean;
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

// --- Desktop shell bridge ---------------------------------------------------

export interface DesktopClientState {
  queued: number;
  running: number;
  lang: "zh" | "en";
}

export const desktopApi = {
  // Host window only: report the in-memory queue so the menubar icon and the
  // quit guard can count pending work. 404 on LAN/older backends — ignore.
  async reportClient(state: DesktopClientState): Promise<{ ok: boolean }> {
    return handle(await fetch("/api/desktop/client", jsonInit("PUT", state)));
  },
};

export const settingsApi = {
  async switchLibrary(index: number, id: string, force = false): Promise<{ ok: true }> {
    return handle(
      await fetch(
        "/api/settings/library/switch",
        jsonInit("POST", { index, id, force }),
      ),
    );
  },
};

export const remoteApi = {
  async session(): Promise<SessionInfo> {
    return handle(await fetch("/api/session", { cache: "no-store" }));
  },
  async hello(): Promise<{ host_name: string; require_code: boolean; server?: boolean }> {
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
  async setRole(id: string, role: "admin" | "member"): Promise<RemoteStatus> {
    return handle(
      await fetch(`/api/remote/sessions/${id}/role`, jsonInit("PUT", { role })),
    );
  },
};
