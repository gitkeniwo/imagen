import type { Locator, Page } from "@playwright/test";
import { expect, openApp, test } from "../fixtures";
import { queueCard, submitPrompt } from "../queue";

// series-v2 B3: the Changes view of a series — versions (consecutive
// attempts with the same configuration), "vs vN" baselines, filters that only
// hide, long-prompt windows, loading by whole versions, narrow layouts, and a
// detail that refreshes only for its own series.
//
// Every test seeds its own series through the API (manual records), so the
// shared template library and the counts other specs rely on stay unchanged.

test.use({ freshLibrary: true });

const PRO = "gemini-3-pro-image";
const FLASH = "gemini-2.5-flash-image";

interface Step {
  prompt: string;
  model?: string;
  ratio?: string;
  res?: string | null;
  inputs?: number[];
  statuses: ("success" | "blocked" | "error")[];
}

/** Images to use as outputs (the template library's first ones). */
async function imageIds(page: Page): Promise<number[]> {
  const res = await page.request.get("/api/images?limit=12");
  return ((await res.json()).images as { id: number }[]).map((img) => img.id);
}

/** A series filled with manual records, oldest first, one minute apart. */
async function seedSeries(page: Page, name: string, steps: Step[]): Promise<number> {
  const theme = await (await page.request.post("/api/series", { data: { kind: "theme", name: `${name} theme` } })).json();
  const series = await (
    await page.request.post("/api/series", { data: { kind: "series", name, parentId: theme.id, color: "#ea580c" } })
  ).json();
  const outs = await imageIds(page);
  const start = Date.now() - 24 * 3600_000;
  let k = 0;
  for (const step of steps) {
    for (const status of step.statuses) {
      k++;
      const res = await page.request.post("/api/generations/manual", {
        data: {
          prompt: step.prompt,
          model: step.model ?? PRO,
          aspectRatio: step.ratio ?? "4:5",
          resolution: step.res === undefined ? "2K" : step.res,
          status,
          source: "vertex",
          errorMessage: status === "success" ? null : status === "blocked" ? "IMAGE_SAFETY" : "503 UNAVAILABLE",
          inputImageIds: step.inputs ?? [outs[0]],
          outputImageId: status === "success" ? outs[k % outs.length] : null,
          createdAt: new Date(start + k * 60_000).toISOString(),
          seriesId: series.id,
        },
      });
      expect(res.ok()).toBeTruthy();
    }
  }
  return series.id as number;
}

async function openSeries(page: Page, name: string) {
  const tab = page.getByRole("tab", { name: "Series", exact: true });
  if (await tab.isVisible()) await tab.click();
  else await page.locator(".phone-tabs").getByRole("button", { name: "Series" }).click();
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect(page.locator(".series-detail h2")).toHaveText(name);
}

/** "Open in workspace" (a header button, or in ⋯ when the detail is narrow). */
async function openInWorkspace(page: Page) {
  const button = page.locator(".series-detail-actions").getByRole("button", { name: "Open in workspace" });
  if (await button.isVisible()) await button.click();
  else {
    await page.locator(".series-detail-head").getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open in workspace" }).click();
  }
}

/** Back to the series list from a detail. */
async function backToList(page: Page) {
  const crumb = page.locator(".series-crumbs").getByRole("button", { name: "Series" });
  if (await crumb.isVisible()) await crumb.click();
  else await page.locator(".series-detail-phonebar").getByRole("button", { name: "Back to series" }).click();
}

const groups = (page: Page) => page.locator(".series-versions > .series-vg");
const group = (page: Page, k: number) => page.locator(`.series-vg[data-version="${k}"]`);
const pills = (page: Page) => page.locator(".series-versions > li").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.version));

test("reruns fold into one version; only neighbours merge; vs vN baselines", async ({ page }) => {
  const ids = await imageIds(page);
  const A = "Amber bottle on an oak table, harsh noon light";
  const B = "Amber bottle on an oak table, soft morning side light";
  await seedSeries(page, "Fold test", [
    { prompt: A, inputs: [ids[0]], statuses: ["success", "success", "error"] },
    { prompt: B, inputs: [ids[0]], statuses: ["success"] },
    { prompt: A, inputs: [ids[0]], statuses: ["success", "success"] },
  ]);
  await openApp(page);
  await openSeries(page, "Fold test");

  // Changes is the default view; the counts are versions / attempts.
  await expect(page.getByRole("button", { name: /^Changes\s*\d/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".series-view-bar")).toContainText("Changes3");
  await expect(page.locator(".series-view-bar")).toContainText("Attempts6");

  // A A A B A A → three versions (A B A), newest first.
  await expect(groups(page)).toHaveCount(3);
  expect(await pills(page)).toEqual(["3", "2", "1"]);
  await expect(group(page, 3).locator(".series-vg-head")).toContainText("v32 tries· 2 ok");
  await expect(group(page, 3).locator(".series-vg-base")).toHaveText("vs v2");
  await expect(group(page, 2).locator(".series-vg-head")).toContainText("1 try");
  await expect(group(page, 2).locator(".series-vg-base")).toHaveText("vs v1");
  await expect(group(page, 2).locator("ins")).toHaveText("soft morning side");
  await expect(group(page, 2).locator("del")).toHaveText("harsh noon");
  // v1: no baseline, the full prompt, "First version".
  await expect(group(page, 1).locator(".series-vg-head")).toContainText("3 tries");
  await expect(group(page, 1)).toContainText("First version");
  await expect(group(page, 1).locator(".series-vg-base")).toHaveCount(0);
  await expect(group(page, 1).locator(".series-vg-prompt")).toHaveText(A);
  // Strip: one tile per attempt; the error shows its code.
  await expect(group(page, 1).locator(".series-vg-thumb")).toHaveCount(3);
  await expect(group(page, 1).locator(".series-vg-thumb.error")).toContainText("503");
  // A 1-try version has no toggle.
  await expect(group(page, 2).locator(".series-vg-toggle")).toHaveCount(0);

  // Expanding shows the Attempts-view rows, newest first.
  await group(page, 1).getByRole("button", { name: "3 attempts" }).click();
  const rows = group(page, 1).locator(".series-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("#3");
  await expect(rows.nth(0)).toContainText("Same prompt as #2 · rerun");
  await expect(rows.nth(2)).toContainText("First try of v1");
  await group(page, 1).getByRole("button", { name: "Hide attempts" }).click();
  await expect(rows).toHaveCount(0);

  // The view choice is remembered.
  await page.getByRole("button", { name: /^Attempts\s*\d/ }).click();
  await expect(page.locator(".series-timeline > .series-row")).toHaveCount(6);
  await expect(page.getByText("Show changes")).toBeVisible();
  await page.reload();
  await openSeries(page, "Fold test");
  await expect(page.getByRole("button", { name: /^Attempts\s*\d/ })).toHaveAttribute("aria-pressed", "true");
});

test("changed parameters become chips; an unchanged prompt says so", async ({ page }) => {
  const ids = await imageIds(page);
  const P = "Amber bottle, dried maple leaves scattered around the base";
  await seedSeries(page, "Params test", [
    { prompt: P, model: FLASH, res: null, ratio: "4:5", inputs: [ids[0]], statuses: ["success"] },
    { prompt: P, model: PRO, res: "2K", ratio: "4:5", inputs: [ids[0]], statuses: ["success"] },
    { prompt: P, model: PRO, res: "2K", ratio: "3:4", inputs: [ids[0], ids[1]], statuses: ["success"] },
  ]);
  await openApp(page);
  await openSeries(page, "Params test");
  await expect(groups(page)).toHaveCount(3);
  await expect(group(page, 3).locator(".series-vg-chip")).toHaveText(["Ratio 4:5 → 3:4", "Inputs 1 → 2"]);
  await expect(group(page, 3).locator(".series-vg-prompt")).toHaveText("vs v2Prompt unchanged");
  await expect(group(page, 2).locator(".series-vg-chip")).toHaveText(["Model Flash → Pro", "2K"]);
  await expect(group(page, 1).locator(".series-vg-chip")).toHaveCount(0);
});

test("filters only hide: thin rows for hidden versions, baselines stay", async ({ page }) => {
  await seedSeries(page, "Filter test", [
    { prompt: "Version one prompt", statuses: ["success", "blocked"] },
    { prompt: "Version two prompt", statuses: ["success"] },
    { prompt: "Version three prompt", statuses: ["blocked", "success", "success"] },
  ]);
  await openApp(page);
  await openSeries(page, "Filter test");
  await expect(groups(page)).toHaveCount(3);

  await page.getByRole("button", { name: "Blocked 2" }).click();
  await expect(page.locator(".series-vg-hidden")).toHaveCount(1);
  await expect(page.locator(".series-vg-hidden")).toHaveText("v2 · 1 attempt hidden");
  await expect(groups(page)).toHaveCount(2);
  await expect(group(page, 3).locator(".series-vg-head")).toContainText("1 of 3 shown");
  // v3 still diffs against v2, which the filter hides completely.
  await expect(group(page, 3).locator(".series-vg-base")).toHaveText("vs v2(hidden)");
  await expect(group(page, 3).locator("ins")).toHaveText("three");
  await expect(group(page, 1).locator(".series-vg-head")).toContainText("1 of 2 shown");
  await expect(group(page, 3).locator(".series-vg-thumb")).toHaveCount(1);
  expect(await pills(page)).toEqual(["3", "2", "1"]);

  await page.getByRole("button", { name: "All 6" }).click();
  await expect(page.locator(".series-vg-hidden")).toHaveCount(0);
  await expect(groups(page)).toHaveCount(3);
});

const LONG = (x: string) =>
  "Studio product photo of an amber perfume bottle on a dark walnut table, soft morning side light, dried maple leaves " +
  "scattered around the base, shallow depth of field, warm autumn palette, editorial magazine look, 85mm lens, subtle film " +
  "grain, clean reflections on the glass, generous negative space at the top for a headline, " +
  x +
  ", no text, no logo, no hands, keep the label blank and centered, matte black cap with a thin gold ring";

/** True when `inner` starts inside `outer`'s visible (clamped) box. */
async function within(inner: Locator, outer: Locator) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  return !!a && !!b && a.y >= b.y - 1 && a.y + 10 <= b.y + b.height;
}

test("long prompts clamp, and the collapsed text starts near the first change", async ({ page }) => {
  const v1 = LONG("warm tungsten practical in the background");
  const v2 = LONG("cool window light from the left, faint blue rim on the bottle shoulder");
  await seedSeries(page, "Long prompt test", [
    { prompt: v1, statuses: ["success"] },
    { prompt: v2, statuses: ["success", "success"] },
  ]);
  await openApp(page);
  await openSeries(page, "Long prompt test");
  const g = group(page, 2);
  const p = g.locator(".series-vg-prompt");
  await expect(g.getByRole("button", { name: `Show all · ${v2.length} chars` })).toBeVisible();
  // The head was cut ("… ") so the change is visible without expanding.
  await expect(g.locator(".series-vg-cut")).toBeVisible();
  expect(await within(g.locator("ins, del").first(), p)).toBe(true);
  const clamped = (await p.boundingBox())!.height;
  expect(clamped).toBeLessThanOrEqual(4 * 24 + 2);

  await g.getByRole("button", { name: /Show all/ }).click();
  await expect(g.locator(".series-vg-cut")).toHaveCount(0);
  await expect(g.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(g.getByRole("button", { name: "Copy prompt" })).toBeVisible();
  expect((await p.boundingBox())!.height).toBeGreaterThan(clamped);
  await g.getByRole("button", { name: "Show less" }).click();
  await expect(g.locator(".series-vg-cut")).toBeVisible();

  // v1 has no baseline: the head of the prompt, clamped, with Show all.
  await expect(group(page, 1).locator(".series-vg-cut")).toHaveCount(0);
  await expect(group(page, 1).getByRole("button", { name: `Show all · ${v1.length} chars` })).toBeVisible();
});

test("scrolling appends whole versions; a version is never split", async ({ page }) => {
  const steps: Step[] = [];
  for (let i = 1; i <= 20; i++) steps.push({ prompt: `Paging variant ${i}`, statuses: ["success", "success"] });
  await seedSeries(page, "Paging test", steps);
  const versionCalls: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/series\/\d+\/versions/.test(req.url())) versionCalls.push(req.url());
  });
  await openApp(page);
  await openSeries(page, "Paging test");
  // First chunk: 15 versions.
  await expect(groups(page)).toHaveCount(15);
  await page.locator(".series-end").scrollIntoViewIfNeeded();
  await expect(groups(page)).toHaveCount(20);
  expect(versionCalls.some((u) => u.includes("cursor=6"))).toBe(true);
  expect(await pills(page)).toEqual(Array.from({ length: 20 }, (_, i) => String(20 - i)));
  for (const head of await groups(page).locator(".series-vg-head strong").allTextContents()) {
    expect(head).toBe("2 tries");
  }

  // A filter starts from the top again.
  await page.getByRole("button", { name: /^Succeeded/ }).click();
  await expect(groups(page)).toHaveCount(15);
  await expect(page.locator(".series-view-bar")).toBeInViewport();
});

test("430 px sidebar and phone layouts", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("imagen-sidebar-width", "430"));
  const steps: Step[] = [{ prompt: "Narrow first", statuses: ["success"] }];
  steps.push({ prompt: LONG("narrow change"), statuses: ["success", "blocked", "success", "success", "success", "success"] });
  await seedSeries(page, "Narrow test", steps);
  await openApp(page);
  await openSeries(page, "Narrow test");
  await expect(page.locator(".series-detail.compact")).toBeVisible();
  const g = group(page, 2);
  await expect(g).toHaveClass(/compact/);
  // One scrolling strip line; the time range on its own line; 3-line clamp.
  const strip = g.locator(".series-vg-strip");
  expect(await strip.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("nowrap");
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(g.locator(".series-vg-when")).toBeVisible();
  expect(await g.locator(".series-vg-prompt").evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("3");
  // The segmented control spans the detail.
  const seg = (await page.locator(".series-view-seg").boundingBox())!;
  const bar = (await page.locator(".series-view-bar").boundingBox())!;
  expect(seg.width).toBeGreaterThan(bar.width - 4);

  // Phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".phone-tabs")).toBeVisible();
  await openSeries(page, "Narrow test");
  await expect(group(page, 2)).toHaveClass(/compact/);
  await expect(page.getByRole("button", { name: /^Changes/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Tapping a clamped prompt expands it.
  await group(page, 2).locator(".series-vg-prompt").click();
  await expect(group(page, 2).getByRole("button", { name: "Show less" })).toBeVisible();
});

test("info card and hover preview use version data", async ({ page }) => {
  await seedSeries(page, "Card test", [
    { prompt: "Card zebrafish one", statuses: ["success"] },
    { prompt: "Card zebrafish two", statuses: ["success", "success", "success"] },
  ]);
  await openApp(page);
  // #4 is the third attempt of v2.
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByPlaceholder("Search prompt…").fill("zebrafish");
  const record = page.getByRole("article").filter({ hasText: "Card zebrafish two" }).first();
  await expect(record).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "Card zebrafish one" })).toBeVisible();
  await page.waitForTimeout(300);
  await record.getByRole("button", { name: "Series: Card test theme / Card test" }).click();
  await expect(page.locator(".sv2-popover .sv2-card-record")).toHaveText(/#4 · v2/);
  await page.keyboard.press("Escape");

  // The series card's hover preview counts the latest version's tries.
  await page.getByRole("tab", { name: "Series", exact: true }).click();
  const card = page.getByRole("button", { name: "Card test", exact: true }).first();
  await page.mouse.move(5, 5);
  await card.hover();
  const peek = page.locator(".series-prompt-peek");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("3 tries");
  await expect(peek).toContainText("Card zebrafish two");
});

test("a finished generation refreshes only its own series", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("imagen-undo-send-seconds", "0"));
  const mine = await seedSeries(page, "Refresh mine", [{ prompt: "Mine first", statuses: ["success"] }]);
  await seedSeries(page, "Refresh other", [{ prompt: "Other first", statuses: ["success"] }]);

  await openApp(page);
  // Bind the composer to the other series, then watch this one.
  await openSeries(page, "Refresh other");
  await openInWorkspace(page);
  await backToList(page);
  await openSeries(page, "Refresh mine");
  await expect(groups(page)).toHaveCount(1);

  const calls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(`/api/series/${mine}/`)) calls.push(req.url());
  });
  await submitPrompt(page, "Other second");
  await expect(queueCard(page, "Other second").locator(".hcard-media img")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500); // the store's debounce + a margin
  expect(calls).toEqual([]);
  await expect(groups(page)).toHaveCount(1);

  // Its own generation refreshes it once, with the new version on top.
  await openInWorkspace(page);
  await backToList(page);
  await openSeries(page, "Refresh mine");
  calls.length = 0;
  await submitPrompt(page, "Mine second");
  await expect(queueCard(page, "Mine second").locator(".hcard-media img")).toBeVisible({ timeout: 20_000 });
  await expect(groups(page)).toHaveCount(2);
  await expect(group(page, 2).locator(".series-vg-head")).toContainText("1 try");
  await page.waitForTimeout(1000);
  expect(calls.filter((u) => u.includes("/versions")).length).toBe(1);
});
