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
  created_at: string;
  tags?: TagRef[];
}

export interface Generation {
  id: number;
  prompt: string;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  status: "success" | "blocked" | "error";
  error_message: string | null;
  raw_finish: string | null;
  output_image_id: number | null;
  created_at: string;
  inputs?: ImageRow[];
  outputImage?: ImageRow | null;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "success"
  | "blocked"
  | "error";

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
  status: TaskStatus;
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
}

export const imgFileUrl = (id: number) => `/api/images/${id}/file`;
export const imgThumbUrl = (id: number) => `/api/images/${id}/thumb`;

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
  } = {}): Promise<{ images: ImageRow[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.source) q.set("source", params.source);
    if (params.tag) q.set("tag", String(params.tag));
    return handle(await fetch(`/api/images?${q.toString()}`));
  },
  async patchImage(id: number, body: { starred?: boolean; filename?: string }) {
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
  async generate(body: GenerateBody): Promise<GenerateResult> {
    return handle(
      await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async listGenerations(
    params: { limit?: number; offset?: number; tag?: number } = {},
  ): Promise<{ generations: Generation[]; total: number }> {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.tag) q.set("tag", String(params.tag));
    return handle(await fetch(`/api/generations?${q.toString()}`));
  },
  async listTags(): Promise<{ tags: Tag[] }> {
    return handle(await fetch("/api/tags"));
  },
  async createTag(name: string, color?: string): Promise<Tag> {
    return handle(
      await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      }),
    );
  },
  async updateTag(
    id: number,
    body: { name?: string; color?: string; coverImageId?: number },
  ): Promise<Tag> {
    return handle(
      await fetch(`/api/tags/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteTag(id: number) {
    return handle(await fetch(`/api/tags/${id}`, { method: "DELETE" }));
  },
  async batchTag(imageIds: number[], tagIds: number[], op: "add" | "remove") {
    return handle(
      await fetch("/api/tags/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageIds, tagIds, op }),
      }),
    );
  },
};

// Pro is first so it is the default selection.
export const MODELS = [
  { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro (3 Pro)", pro: true },
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
