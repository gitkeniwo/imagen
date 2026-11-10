// Word-level prompt diff for the series timeline. Pure functions only, so the
// test script (frontend/scripts/promptDiff.test.mjs) can run them under Node.
//
// Latin text diffs by word and punctuation mark (a token keeps its trailing
// whitespace); CJK text has no spaces, so every CJK character / full-width
// mark is its own token.

export type DiffKind = "equal" | "insert" | "delete";

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

const CJK = "\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
// CJK character | word (letters, digits, apostrophes, hyphens) | any other
// single mark, so "leaves," diffs as "leaves" + "," | leading whitespace.
const TOKEN = new RegExp(`[${CJK}]\\s*|[\\p{L}\\p{N}_'’-]+\\s*|[^\\s${CJK}]\\s*|\\s+`, "gu");

// Above this many LCS cells the middle is shown as one delete + one insert.
const MAX_CELLS = 4_000_000;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

const key = (token: string) => token.trimEnd();

/** Diff `before` → `after`. Joining every non-delete segment gives `after`;
 *  joining every non-insert segment gives `before`. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && key(a[start]) === key(b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && key(a[endA - 1]) === key(b[endB - 1])) {
    endA--;
    endB--;
  }

  const ops: { kind: DiffKind; token: string }[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "equal", token: b[i] });

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB).
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          key(a[start + i]) === key(b[start + j])
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (key(a[start + i]) === key(b[start + j])) {
        ops.push({ kind: "equal", token: b[start + j] });
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        ops.push({ kind: "delete", token: a[start + i] });
        i++;
      } else {
        ops.push({ kind: "insert", token: b[start + j] });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ kind: "delete", token: a[start + i] });
    for (; j < m; j++) ops.push({ kind: "insert", token: b[start + j] });
  } else {
    for (let i = start; i < endA; i++) ops.push({ kind: "delete", token: a[i] });
    for (let j = start; j < endB; j++) ops.push({ kind: "insert", token: b[j] });
  }
  for (let j = endB; j < b.length; j++) ops.push({ kind: "equal", token: b[j] });

  return mergeRuns(ops);
}

// Merge runs of one kind. A changed run may end in whitespace (tokens keep
// theirs); renderers draw that tail unmarked, see `splitTrailingSpace`.
function mergeRuns(ops: { kind: DiffKind; token: string }[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.kind === op.kind) last.text += op.token;
    else out.push({ kind: op.kind, text: op.token });
  }
  return out;
}

/** Shorten long unchanged runs to their edges ("… soft morning") so a
 *  clamped, narrow view still shows where the change is. Changed runs and
 *  short equal runs are kept as they are. */
export function compactEqual(segments: DiffSegment[], keep = 4): DiffSegment[] {
  if (!segments.some((seg) => seg.kind !== "equal")) return segments;
  return segments.map((seg, i) => {
    if (seg.kind !== "equal") return seg;
    const words = seg.text.split(/(?<=\s)/);
    if (words.length <= keep * 2) return seg;
    const first = i === 0;
    const last = i === segments.length - 1;
    if (first) return { kind: "equal", text: `… ${words.slice(-keep).join("")}` };
    if (last) return { kind: "equal", text: `${words.slice(0, keep).join("")}…` };
    return { kind: "equal", text: `${words.slice(0, keep).join("")}… ${words.slice(-keep).join("")}` };
  });
}

/** [marked body, unmarked trailing whitespace] of a changed segment. */
export function splitTrailingSpace(text: string): [string, string] {
  const body = text.trimEnd();
  return [body, text.slice(body.length)];
}

/** The prompt as versions compare it: edge whitespace (JS `trim`) removed.
 *  backend/app/series_order.py `normalize_prompt` mirrors this exactly. */
export function normalizePrompt(prompt: string | null | undefined): string {
  return (prompt ?? "").trim();
}

/** True when nothing but the edges' whitespace differs. */
export function samePrompt(before: string, after: string): boolean {
  return normalizePrompt(before) === normalizePrompt(after);
}

// series-v2 B2
export interface VersionKeyInput {
  prompt: string | null;
  model: string | null;
  resolution: string | null;
  aspect_ratio: string | null;
  input_ids: number[];
}

/** Attempts with the same key, next to each other in a series, form one
 *  version. Provider is deliberately left out. Mirrors `version_key` in
 *  backend/app/series_order.py; both are tested against
 *  scripts/fixtures/version-key.json. */
export function versionKey(a: VersionKeyInput): string {
  return JSON.stringify([
    normalizePrompt(a.prompt),
    a.model ?? "",
    a.resolution ?? "",
    a.aspect_ratio ?? "",
    [...a.input_ids],
  ]);
}

export type ParamKey = "provider" | "model" | "aspect_ratio" | "resolution" | "inputs";

export interface ParamSnapshot {
  provider?: string | null;
  model: string;
  aspect_ratio: string | null;
  resolution: string | null;
  input_ids: number[];
}

/** Parameters of `current` that differ from `previous` (none without one). */
export function changedParams(
  previous: ParamSnapshot | null | undefined,
  current: ParamSnapshot,
): Set<ParamKey> {
  const changed = new Set<ParamKey>();
  if (!previous) return changed;
  if ((previous.provider ?? "vertex") !== (current.provider ?? "vertex")) changed.add("provider");
  if (previous.model !== current.model) changed.add("model");
  if ((previous.aspect_ratio ?? "") !== (current.aspect_ratio ?? "")) changed.add("aspect_ratio");
  if ((previous.resolution ?? "") !== (current.resolution ?? "")) changed.add("resolution");
  const a = previous.input_ids;
  const b = current.input_ids;
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) changed.add("inputs");
  return changed;
}
