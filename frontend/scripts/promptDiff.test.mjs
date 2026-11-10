// Run: npm test   (node --test, no extra dependencies; Node strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { changedParams, compactEqual, diffWords, samePrompt, splitTrailingSpace, tokenize, versionKey } from "../src/promptDiff.ts";

const join = (segs, skip) => segs.filter((s) => s.kind !== skip).map((s) => s.text).join("");
const marks = (segs) => segs.filter((s) => s.kind !== "equal").map((s) => `${s.kind === "insert" ? "+" : "-"}${s.text.trim()}`);

test("joins back to both prompts (after exactly, before up to spacing)", () => {
  const cases = [
    ["Warm-toned poster of a perfume bottle", "Warm-toned poster of an amber perfume bottle"],
    ["", "new prompt"],
    ["old prompt", ""],
    ["a  b   c", "a b c d"],
    ["秋天的香水海报，橡木桌", "秋天的琥珀色香水海报，橡木桌，晨光"],
    ["same", "same"],
  ];
  for (const [a, b] of cases) {
    const segs = diffWords(a, b);
    // Equal runs carry the new text's spacing, so "before" matches up to whitespace.
    const norm = (x) => x.replace(/\s+/g, " ").trim();
    assert.equal(norm(join(segs, "insert")), norm(a), `before of ${a} -> ${b}`);
    assert.equal(join(segs, "delete"), b, `after of ${a} -> ${b}`);
  }
});

test("word-level insert and delete", () => {
  const segs = diffWords(
    "Warm poster of a perfume bottle on an oak table, soft morning light, maple leaves",
    "Warm poster of an amber perfume bottle on an oak table, soft morning side light, dried maple leaves",
  );
  assert.deepEqual(marks(segs), ["-a", "+an amber", "+side", "+dried"]);
});

test("removed phrase is a single delete", () => {
  const segs = diffWords(
    "amber bottle held by a model's hand on an oak table",
    "amber bottle on an oak table",
  );
  assert.deepEqual(marks(segs), ["-held by a model's hand"]);
});

test("punctuation is its own token", () => {
  assert.deepEqual(
    marks(diffWords("dried maple leaves", "dried maple leaves, negative space at the top")),
    ["+, negative space at the top"],
  );
});

test("CJK diffs per character", () => {
  assert.deepEqual(tokenize("香水海报"), ["香", "水", "海", "报"]);
  assert.deepEqual(marks(diffWords("香水海报", "琥珀香水海报")), ["+琥珀"]);
});

test("whitespace-only change keeps prompts equal", () => {
  assert.equal(samePrompt(" a b ", "a b"), true);
  assert.equal(samePrompt("a b", "a c"), false);
});

test("trailing space stays outside the mark", () => {
  assert.deepEqual(splitTrailingSpace("amber "), ["amber", " "]);
});

test("changed parameters", () => {
  const base = { provider: "vertex", model: "m", aspect_ratio: "2:3", resolution: "1K", input_ids: [1, 2] };
  assert.deepEqual([...changedParams(null, base)], []);
  assert.deepEqual([...changedParams(base, { ...base })], []);
  assert.deepEqual(
    [...changedParams(base, { ...base, resolution: "2K", input_ids: [2, 1] })].sort(),
    ["inputs", "resolution"],
  );
});

test("compactEqual keeps the edges of long unchanged runs", () => {
  const segs = diffWords(
    "Warm-toned poster of an amber perfume bottle on an oak table soft morning light",
    "Warm-toned poster of an amber perfume bottle on an oak table soft morning side light",
  );
  const out = compactEqual(segs);
  assert.ok(out[0].text.startsWith("… "));
  assert.ok(out[0].text.endsWith("soft morning "));
  assert.deepEqual(marks(out), ["+side"]);
  const same = diffWords("a b", "a b");
  assert.deepEqual(compactEqual(same), same);
});

// series-v2 B2: the same cases run against backend/app/series_order.py in
// desktop/scripts/check_series.py.
const versionCases = JSON.parse(
  readFileSync(new URL("./fixtures/version-key.json", import.meta.url), "utf8"),
);

test("versionKey matches the shared fixture byte for byte", () => {
  for (const c of versionCases.keys) assert.equal(versionKey(c.attempt), c.key, c.name);
});

test("versionKey groups exactly the shared same / different pairs", () => {
  for (const c of versionCases.pairs) {
    assert.equal(versionKey(c.a) === versionKey(c.b), c.same, c.name);
    // When only the prompt differs, the key agrees with samePrompt.
    const { prompt: pa, ...restA } = c.a;
    const { prompt: pb, ...restB } = c.b;
    if (JSON.stringify(restA) === JSON.stringify(restB)) {
      assert.equal(samePrompt(pa ?? "", pb ?? ""), c.same, `samePrompt: ${c.name}`);
    }
  }
});
