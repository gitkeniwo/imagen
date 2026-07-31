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
  status: "success" | "blocked" | "error" | "aborted" | "note";
  error_message: string | null;
  raw_finish: string | null;
  output_image_id: number | null;
  created_at: string;
  source: "vertex" | "manual";
  inputs?: ImageRow[];
  outputImage?: ImageRow | null;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "success"
  | "blocked"
  | "error"
  | "aborted";

// A client-side queued generation task (snapshot of the composer at submit time).
export interface QueueTask {
  id: string;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string | null;
  format: string;
  inputs: ImageRow[];
  tagIds: number[];
  skipIfPrecedingSucceeds?: boolean;
  status: TaskStatus;
  // When (ms epoch) this task may actually be dispatched to the backend. Until
  // then it sits in the "undo send" countdown window and can be cancelled with
  // a guaranteed no-charge (the request is never sent).
  dispatchAt: number;
  // Live backend phase while running (polled); undefined until first poll.
  phase?: TaskPhase;
  message?: string | null;
  text?: string | null;
  rawFinish?: string | null;
  outputImage?: ImageRow | null;
}

export interface GenerateResult {
  status: "success" | "blocked" | "error";
  message: string | null;
  text: string | null;
  generation: Generation;
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
}

export interface ManualGenerationBody {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  status: "success" | "blocked" | "error" | "note";
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
}

// All metrics for a single time window — the whole dashboard switches together.
export interface PeriodStats {
  total: number;
  by_status: Record<string, number>;
  by_model: Record<string, number>;
  cost_basis: CostBasisRow[];
  images: { total: number; by_source: Record<string, number>; bytes: number };
  chart: SeriesPoint[];
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
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export interface VertexConfig {
  project: string | null;
  location: string;
  configured: boolean;
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
  async getStats(): Promise<Stats> {
    return handle(await fetch("/api/stats"));
  },
  async listGenerations(
    params: {
      limit?: number;
      offset?: number;
      tag?: number;
      q?: string;
      starred?: boolean;
      kind?: "vertex" | "manual" | "note";
    } = {},
  ): Promise<{ generations: Generation[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.tag) q.set("tag", String(params.tag));
    if (params.q && params.q.trim()) q.set("q", params.q.trim());
    if (params.starred) q.set("starred", "true");
    if (params.kind) q.set("kind", params.kind);
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
