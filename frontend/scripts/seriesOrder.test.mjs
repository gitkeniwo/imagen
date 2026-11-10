// Run: npm test   (node --test, no extra dependencies; Node strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMove, currentRuns, groupTags, placeAt, regroupVersions, runsOf, stepMove } from "../src/seriesOrder.ts";

/** An order map for configs like "AAABBBA" (ids 1..n, #N = id). */
function orderOf(configs, statuses = {}) {
  const keys = [...new Set(configs)];
  const items = [];
  let version = 0;
  [...configs].forEach((c, i) => {
    if (i === 0 || configs[i - 1] !== c) version++;
    items.push({ id: i + 1, seq: i + 1, version, k: keys.indexOf(c), status: statuses[i + 1] ?? "success", created_at: "", output_image_id: null });
  });
  return { items, keys, order_custom: false };
}

const configsOf = (order, ids) => ids.map((id) => order.keys[order.items.find((it) => it.id === id).k]).join("");

test("applyMove keeps the block's relative order", () => {
  assert.deepEqual(applyMove([1, 2, 3, 4, 5], [4, 2], { before: 1 }), [2, 4, 1, 3, 5]);
  assert.deepEqual(applyMove([1, 2, 3, 4, 5], [1, 2], { after: 5 }), [3, 4, 5, 1, 2]);
  assert.deepEqual(applyMove([1, 2, 3], [2], { after: 9 }), [1, 2, 3]);
});

test("step inside a version moves one slot", () => {
  const o = orderOf("AAABBB");
  assert.deepEqual(stepMove(o, [2], "later").order, [1, 3, 2, 4, 5, 6]);
  assert.deepEqual(stepMove(o, [2], "earlier").order, [2, 1, 3, 4, 5, 6]);
});

test("step at a version's edge jumps the whole neighbour (design example)", () => {
  // v4 = #11–13 (A), v5 = #14–16 (B): moving #13 later → A A B B B A.
  const o = orderOf("AAABBB");
  const m = stepMove(o, [3], "later");
  assert.deepEqual(m.placement, { after: 6 });
  assert.equal(configsOf(o, m.order), "AABBBA");
  // The neighbour stays whole.
  assert.deepEqual(m.order, [1, 2, 4, 5, 6, 3]);
  // Back the other way: #4 (first B) earlier jumps the whole A version.
  assert.deepEqual(stepMove(o, [4], "earlier").order, [4, 1, 2, 3, 5, 6]);
});

test("a whole version swaps with its neighbour; ends are no-ops", () => {
  const o = orderOf("AABBBCC");
  assert.deepEqual(stepMove(o, [3, 4, 5], "later").order, [1, 2, 6, 7, 3, 4, 5]);
  assert.deepEqual(stepMove(o, [3, 4, 5], "earlier").order, [3, 4, 5, 1, 2, 6, 7]);
  assert.equal(stepMove(o, [7], "later"), null);
  assert.equal(stepMove(o, [1, 2], "earlier"), null);
  assert.equal(stepMove(o, [], "later"), null);
});

test("placeAt skips anchors that move and reports no-ops", () => {
  const order = [1, 2, 3, 4, 5];
  assert.deepEqual(placeAt(order, [5], [2, 3], "before").order, [1, 5, 2, 3, 4]);
  assert.deepEqual(placeAt(order, [1], [3, 4], "after").placement, { after: 4 });
  assert.deepEqual(placeAt(order, [3], [3, 4], "after").placement, { after: 4 });
  assert.equal(placeAt(order, [3, 4], [3, 4], "after"), null);
  assert.equal(placeAt(order, [2], [3], "before"), null);
});

test("groupTags: neighbours merge when the middle leaves, a drop inside splits", () => {
  // v4 A #11–13, v5 B #14, v6 A #15–16; drag #14 out to the end → A A A A A B.
  const o = orderOf("AAABAA");
  const before = currentRuns(o);
  const next = applyMove(o.items.map((it) => it.id), [4], { after: 6 });
  const after = runsOf(next, (id) => o.items[id - 1].k);
  assert.deepEqual(after.map((r) => r.ids), [[1, 2, 3, 5, 6], [4]]);
  assert.deepEqual(groupTags(before, after, [4]).get(1), { kind: "merged", from: [1, 3] });
  assert.equal(groupTags(before, after, [4]).has(2), false);

  // Dropping B between two A's splits that version.
  const o2 = orderOf("AAAB");
  const split = applyMove([1, 2, 3, 4], [4], { after: 1 });
  const tags = groupTags(currentRuns(o2), runsOf(split, (id) => o2.items[id - 1].k), [4]);
  assert.deepEqual(tags.get(1), { kind: "split", from: 1 });
  assert.deepEqual(tags.get(3), { kind: "split", from: 1 });
});

const P = (model = "pro") => ({ model, aspect_ratio: "4:5", resolution: "2K", input_ids: [] });

function versionsOf(order, prompts, params = {}) {
  // The server's answer: every version, newest first, everything loaded.
  const runs = currentRuns(order);
  return runs
    .map((r, i) => ({
      version: r.version,
      key: order.keys[r.k],
      first_seq: r.ids[0],
      last_seq: r.ids[r.ids.length - 1],
      prompt: prompts[order.keys[r.k]],
      params: params[order.keys[r.k]] ?? P(),
      changed_params: [],
      prompt_changed: i > 0,
      base_version: i > 0 ? i : null,
      base_prompt: null,
      base_params: null,
      base_hidden: false,
      inputs: [],
      attempts: r.ids.map((id) => ({ id, seq: id, status: order.items[id - 1].status })),
      attempts_total: r.ids.length,
      counts: { all: r.ids.length, success: r.ids.length, blocked: 0, error: 0, aborted: 0 },
      hidden: false,
    }))
    .reverse();
}

const same = (a, b) => a.trim() === b.trim();

test("regroupVersions rebuilds the Changes view after a move", () => {
  const o = orderOf("AAABAA");
  const loaded = versionsOf(o, { A: "amber", B: "blue" }, { B: P("flash") });
  const next = applyMove([1, 2, 3, 4, 5, 6], [4], { after: 6 });
  const vs = regroupVersions(o, next, loaded, undefined, same);
  assert.deepEqual(vs.map((v) => v.version), [2, 1]);
  assert.deepEqual(vs[1].attempts.map((a) => [a.id, a.seq]), [[1, 1], [2, 2], [3, 3], [5, 4], [6, 5]]);
  assert.equal(vs[0].prompt, "blue");
  assert.equal(vs[0].base_version, 1);
  assert.equal(vs[0].base_prompt, "amber");
  assert.deepEqual(vs[0].changed_params, ["model"]);
  assert.equal(vs[0].prompt_changed, true);
  assert.equal(vs[1].base_version, null);
  assert.equal(vs[0].first_seq, 6);
});

test("regroupVersions: filters hide, unloaded data gives up", () => {
  const o = orderOf("AAB", { 3: "error" });
  const loaded = versionsOf(o, { A: "amber", B: "blue" });
  // Filter "error": the A version is hidden, B keeps its attempt.
  const filtered = loaded.map((v) => ({ ...v, attempts: v.attempts.filter((a) => a.status === "error") }))
    .map((v) => ({ ...v, attempts_total: v.attempts.length, hidden: v.attempts.length === 0 }));
  const vs = regroupVersions(o, [3, 1, 2], filtered, "error", same);
  assert.deepEqual(vs.map((v) => [v.version, v.hidden]), [[2, true], [1, false]]);
  assert.equal(vs[0].base_hidden, false);
  assert.equal(regroupVersions(o, [3, 1, 2], [], undefined, same).length, 0);
  // Only the newest version loaded and the move needs v1's configuration.
  assert.equal(regroupVersions(o, [3, 1, 2], loaded.slice(0, 1), undefined, same), null);
});
