import type {
  HistoryResult,
  SeriesOrder,
  SeriesOrderItem,
  SeriesVersion,
  SeriesVersionAttempt,
  SeriesVersionParam,
  SeriesVersionParams,
} from "./api";

// series-v2 B4: custom order inside a series, computed on the client.
//
// "Earlier" / "later" always mean series order (#1 is the earliest). The
// detail shows newest first, so "up" on screen is "later" here.
//
// No runtime imports: `npm test` runs this file under plain Node.

export type Placement = { before: number } | { after: number };

export interface PlannedMove {
  /** Moved records, in their current relative order. */
  ids: number[];
  placement: Placement;
  /** The full order after the move. */
  order: number[];
}

/** Move `ids` as one block (current relative order) next to the target. */
export function applyMove(order: number[], ids: number[], placement: Placement): number[] {
  const moving = new Set(ids);
  const block = order.filter((id) => moving.has(id));
  const rest = order.filter((id) => !moving.has(id));
  const target = "before" in placement ? placement.before : placement.after;
  let at = rest.indexOf(target);
  if (at < 0) return order;
  if ("after" in placement) at += 1;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

const sameOrder = (a: number[], b: number[]) => a.length === b.length && a.every((id, i) => id === b[i]);

function plan(order: number[], ids: number[], placement: Placement): PlannedMove | null {
  const next = applyMove(order, ids, placement);
  if (sameOrder(order, next)) return null;
  const moving = new Set(ids);
  return { ids: order.filter((id) => moving.has(id)), placement, order: next };
}

export interface VersionRun {
  version: number;
  k: number;
  ids: number[];
}

/** Consecutive records with the same configuration key, numbered from 1. */
export function runsOf(ids: number[], keyOf: (id: number) => number): VersionRun[] {
  const runs: VersionRun[] = [];
  for (const id of ids) {
    const k = keyOf(id);
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.ids.push(id);
    else runs.push({ version: runs.length + 1, k, ids: [id] });
  }
  return runs;
}

/** The versions of the order as it is now. */
export function currentRuns(order: SeriesOrder): VersionRun[] {
  const runs: VersionRun[] = [];
  for (const it of order.items) {
    const last = runs[runs.length - 1];
    if (last && last.version === it.version) last.ids.push(it.id);
    else runs.push({ version: it.version, k: it.k, ids: [it.id] });
  }
  return runs;
}

/**
 * Move up / Move down (§3 rule 5): inside a version one slot; at the
 * version's edge past the whole neighbouring version, so a single step never
 * splits a neighbour. `null` = nothing to do (already at that end).
 */
export function stepMove(order: SeriesOrder, ids: number[], dir: "earlier" | "later"): PlannedMove | null {
  const all = order.items.map((it) => it.id);
  const versionOf = new Map(order.items.map((it) => [it.id, it.version]));
  const moving = new Set(ids);
  const picked = all.map((id, i) => (moving.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!picked.length) return null;
  if (dir === "later") {
    const edge = picked[picked.length - 1];
    const j = all.findIndex((id, i) => i > edge && !moving.has(id));
    if (j < 0) return null;
    const next = all[j];
    if (versionOf.get(next) === versionOf.get(all[edge])) return plan(all, ids, { after: next });
    const v = versionOf.get(next);
    const lastOf = [...all].reverse().find((id) => versionOf.get(id) === v && !moving.has(id))!;
    return plan(all, ids, { after: lastOf });
  }
  const edge = picked[0];
  let j = -1;
  for (let i = edge - 1; i >= 0; i--) {
    if (!moving.has(all[i])) {
      j = i;
      break;
    }
  }
  if (j < 0) return null;
  const prev = all[j];
  if (versionOf.get(prev) === versionOf.get(all[edge])) return plan(all, ids, { before: prev });
  const v = versionOf.get(prev);
  const firstOf = all.find((id) => versionOf.get(id) === v && !moving.has(id))!;
  return plan(all, ids, { before: firstOf });
}

/** Place `ids` right before the first / after the last of `anchor` (a row
 *  or a whole version), skipping anchor records that move themselves. */
export function placeAt(
  order: number[],
  ids: number[],
  anchor: number[],
  side: "before" | "after",
): PlannedMove | null {
  const moving = new Set(ids);
  const left = order.filter((id) => anchor.includes(id) && !moving.has(id));
  if (!left.length) return null;
  return plan(order, ids, side === "before" ? { before: left[0] } : { after: left[left.length - 1] });
}

export type GroupTag = { kind: "merged"; from: number[] } | { kind: "split"; from: number };

/** "merged v4 + v6" / "split from v4" for the versions after a move. The
 *  moved records themselves don't count: a version they joined or left is
 *  neither merged nor split. Keys are new version numbers. */
export function groupTags(before: VersionRun[], after: VersionRun[], moved: number[]): Map<number, GroupTag> {
  const skip = new Set(moved);
  const oldVersion = new Map<number, number>();
  for (const r of before) for (const id of r.ids) oldVersion.set(id, r.version);
  const newVersion = new Map<number, number>();
  for (const r of after) for (const id of r.ids) newVersion.set(id, r.version);
  const tags = new Map<number, GroupTag>();
  for (const r of after) {
    const from = [...new Set(r.ids.filter((id) => !skip.has(id)).map((id) => oldVersion.get(id)!))];
    if (from.length >= 2) tags.set(r.version, { kind: "merged", from: from.sort((a, b) => a - b) });
  }
  for (const r of before) {
    const into = [...new Set(r.ids.filter((id) => !skip.has(id)).map((id) => newVersion.get(id)!))];
    if (into.length < 2) continue;
    for (const v of into) if (!tags.has(v)) tags.set(v, { kind: "split", from: r.version });
  }
  return tags;
}

const RESULT_STATUSES: Record<HistoryResult, string[]> = {
  success: ["success"],
  blocked: ["blocked"],
  error: ["error", "aborted"],
};

export const matchesFilter = (status: string, filter: HistoryResult | undefined) =>
  !filter || RESULT_STATUSES[filter].includes(status);

function paramsChanged(prev: SeriesVersionParams, cur: SeriesVersionParams): SeriesVersionParam[] {
  const out: SeriesVersionParam[] = [];
  for (const k of ["model", "aspect_ratio", "resolution"] as const) {
    if ((prev[k] ?? "") !== (cur[k] ?? "")) out.push(k);
  }
  const a = prev.input_ids;
  const b = cur.input_ids;
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) out.push("inputs");
  // The backend's order: model, aspect_ratio, resolution, inputs.
  return out;
}

/**
 * The Changes view after a move, built from what is already loaded, so the
 * list can change before the server answers. Shows the new versions down to
 * the oldest one holding a record that was on screen. `null` when something
 * it would show is not loaded (an unloaded configuration or attempt, a
 * clipped version): the caller then waits for the server.
 */
export function regroupVersions(
  order: SeriesOrder,
  newOrder: number[],
  loaded: SeriesVersion[],
  filter: HistoryResult | undefined,
  samePrompt: (a: string, b: string) => boolean,
): SeriesVersion[] | null {
  if (!loaded.length) return [];
  const item = new Map<number, SeriesOrderItem>(order.items.map((it) => [it.id, it]));
  const keyIndex = new Map(order.keys.map((key, i) => [key, i]));
  const reps = new Map<number, SeriesVersion>();
  const attempts = new Map<number, SeriesVersionAttempt>();
  for (const v of loaded) {
    if (v.attempts.length < v.attempts_total) return null;
    const k = keyIndex.get(v.key);
    if (k === undefined) return null;
    if (!reps.has(k)) reps.set(k, v);
    for (const a of v.attempts) attempts.set(a.id, a);
  }
  const oldest = Math.min(...loaded.map((v) => v.version));
  const onScreen = new Set(order.items.filter((it) => it.version >= oldest).map((it) => it.id));
  const runs = runsOf(newOrder, (id) => item.get(id)?.k ?? -1);
  let from = runs.findIndex((r) => r.ids.some((id) => onScreen.has(id)));
  if (from < 0) from = runs.length;
  const seq = new Map(newOrder.map((id, i) => [id, i + 1]));
  const out: SeriesVersion[] = [];
  for (let i = runs.length - 1; i >= from; i--) {
    const r = runs[i];
    const rep = reps.get(r.k);
    const base = i > 0 ? runs[i - 1] : null;
    const baseRep = base ? reps.get(base.k) : null;
    if (!rep || (base && !baseRep)) return null;
    const shown: SeriesVersionAttempt[] = [];
    const counts = { all: r.ids.length, success: 0, blocked: 0, error: 0, aborted: 0 };
    for (const id of r.ids) {
      const status = item.get(id)?.status ?? "error";
      if (status !== "running" && status !== "note" && status in counts) counts[status]++;
      if (!matchesFilter(status, filter)) continue;
      const a = attempts.get(id);
      if (!a) return null;
      shown.push({ ...a, seq: seq.get(id)! });
    }
    out.push({
      ...rep,
      version: r.version,
      first_seq: seq.get(r.ids[0])!,
      last_seq: seq.get(r.ids[r.ids.length - 1])!,
      changed_params: baseRep ? paramsChanged(baseRep.params, rep.params) : [],
      prompt_changed: baseRep ? !samePrompt(baseRep.prompt, rep.prompt) : false,
      base_version: base ? base.version : null,
      base_prompt: baseRep ? baseRep.prompt : null,
      base_params: baseRep ? baseRep.params : null,
      base_hidden: !!base && !!filter && !base.ids.some((id) => matchesFilter(item.get(id)?.status ?? "", filter)),
      attempts: shown,
      attempts_total: shown.length,
      counts,
      hidden: shown.length === 0,
    });
  }
  return out;
}

/** The order map after a move: same records, new #N and vK. */
export function withOrder(order: SeriesOrder, ids: number[]): SeriesOrder {
  const item = new Map(order.items.map((it) => [it.id, it]));
  const items: SeriesOrderItem[] = [];
  for (const r of runsOf(ids, (id) => item.get(id)?.k ?? -1)) {
    for (const id of r.ids) items.push({ ...item.get(id)!, seq: items.length + 1, version: r.version });
  }
  return { ...order, items };
}
