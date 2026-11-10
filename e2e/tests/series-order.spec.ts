import type { Locator, Page } from "@playwright/test";
import { expect, openApp, test } from "../fixtures";

// series-v2 B4: custom order inside a series — drag (one attempt, a
// selection, a whole version), the menu path (up / down jump over whole
// versions, before… / after… with the position picker), ⌥↑/↓, reset to time
// order with Undo, rollback on failure, the phone menu, and History staying
// in time order.
//
// Every test seeds its own series through the API (manual records), so the
// shared template library stays unchanged. The detail lists newest first:
// "up" on screen is later in the series order.

test.use({ freshLibrary: true });

// The desktop tests use the wide (760 px) sidebar, so the detail is not compact.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.innerWidth >= 640) localStorage.setItem("imagen-sidebar-width", "760");
  });
});

/** Seeds a series from a config string like "AAABBB" (one manual record per
 *  letter, one minute apart). Returns the series id and the record ids in
 *  time order. */
async function seed(page: Page, name: string, configs: string): Promise<{ sid: number; ids: number[] }> {
  const theme = await (await page.request.post("/api/series", { data: { kind: "theme", name: `${name} theme` } })).json();
  const series = await (
    await page.request.post("/api/series", { data: { kind: "series", name, parentId: theme.id, color: "#0891b2" } })
  ).json();
  const imgs = ((await (await page.request.get("/api/images?limit=8")).json()).images as { id: number }[]).map((i) => i.id);
  const start = Date.now() - 24 * 3600_000;
  const ids: number[] = [];
  for (const [k, c] of [...configs].entries()) {
    const res = await page.request.post("/api/generations/manual", {
      data: {
        prompt: `Config ${c}: amber bottle on an oak table`,
        model: "gemini-3-pro-image",
        aspectRatio: "4:5",
        resolution: "2K",
        status: "success",
        source: "vertex",
        inputImageIds: [imgs[0]],
        outputImageId: imgs[(k + 1) % imgs.length],
        createdAt: new Date(start + (k + 1) * 60_000).toISOString(),
        seriesId: series.id,
      },
    });
    expect(res.ok()).toBeTruthy();
    ids.push((await res.json()).id);
  }
  return { sid: series.id, ids };
}

async function openSeries(page: Page, name: string) {
  const tab = page.getByRole("tab", { name: "Series", exact: true });
  if (await tab.isVisible()) await tab.click();
  else await page.locator(".phone-tabs").getByRole("button", { name: "Series" }).click();
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect(page.locator(".series-detail h2")).toHaveText(name);
}

async function order(page: Page, sid: number): Promise<number[]> {
  const res = await page.request.get(`/api/series/${sid}/order`);
  return ((await res.json()).items as { id: number }[]).map((it) => it.id);
}

/** Moves are optimistic; wait until the backend order reflects the action. */
async function expectOrder(page: Page, sid: number, expected: number[]) {
  await expect.poll(() => order(page, sid)).toEqual(expected);
}

const groups = (page: Page) => page.locator(".series-versions > .series-vg");
const group = (page: Page, k: number) => page.locator(`.series-vg[data-version="${k}"]`);
const pills = (page: Page) =>
  page.locator(".series-versions > li").evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.version)));
const row = (page: Page, n: number) =>
  page.locator(".series-row").filter({ has: page.locator(".series-row-n", { hasText: new RegExp(`^#${n}$`) }) });

async function groupMenu(page: Page, k: number, item: string) {
  await group(page, k).locator(".series-vg-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function rowMenu(page: Page, n: number, item: string) {
  const r = row(page, n);
  await r.hover();
  await r.locator(".series-row-actions").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Pointer drag from a grip to the upper or lower half of a target. */
async function drag(page: Page, grip: Locator, target: Locator, where: "above" | "below") {
  await grip.scrollIntoViewIfNeeded();
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 12, g.y + 16, { steps: 3 });
  await expect(page.locator(".series-drag-stack")).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const t = (await target.boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, where === "above" ? t.y + 6 : t.y + t.height - 6, { steps: 8 });
  await expect(page.locator(".series-drop-line")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".series-drag-stack")).toHaveCount(0);
}

const toast = (page: Page, text: string | RegExp) => page.locator(".toast").filter({ hasText: text });

test("drag one version, split a version, drag a selection", async ({ page }) => {
  // v1 = A #1–3, v2 = B #4, v3 = A #5–6.
  const { sid, ids } = await seed(page, "Drag test", "AAABAA");
  const [a1, a2, a3, b1, a4, a5] = ids;
  await openApp(page);
  await openSeries(page, "Drag test");
  expect(await pills(page)).toEqual([3, 2, 1]);
  await expect(page.locator(".series-order")).toHaveText("Newest first");

  // Grips appear on hover; dragging B below v1 makes it the first record,
  // and the two A versions merge.
  const grip = group(page, 2).locator(".series-grip");
  await group(page, 2).locator(".series-vg-head").hover();
  await expect(grip).toHaveCSS("opacity", "1");
  await drag(page, grip, group(page, 1), "below");
  await expect(toast(page, "Moved 1 attempt · numbers updated")).toBeVisible();
  await expectOrder(page, sid, [b1, a1, a2, a3, a4, a5]);
  await expect(groups(page)).toHaveCount(2);
  await expect(group(page, 2).locator(".series-group-tag")).toHaveText("merged v1 + v3");
  await expect(group(page, 1).locator(".series-was")).toHaveText("was #4");
  await expect(page.locator(".series-order-chip")).toHaveText("Custom order");

  // Dropping between two attempts of an expanded version splits it.
  await group(page, 2).getByRole("button", { name: "5 attempts" }).click();
  await drag(page, group(page, 1).locator(".series-grip"), row(page, 3), "above");
  await expectOrder(page, sid, [a1, a2, b1, a3, a4, a5]);
  expect(await pills(page)).toEqual([3, 2, 1]);
  await expect(page.locator(".series-group-tag", { hasText: "split from v2" }).first()).toBeVisible();

  // Selection mode: two attempts from different versions move together.
  await page.locator(".series-detail-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Select" }).click();
  await page.getByRole("checkbox", { name: "Select #2" }).first().click();
  await page.getByRole("checkbox", { name: "Select #6" }).first().click();
  await expect(page.locator(".series-select-bar")).toContainText("2 selected");
  await expect(group(page, 3).locator(".series-vg-head")).toContainText("1 of 3 selected");
  // The grip of a version holding a selected attempt drags the selection.
  await drag(page, group(page, 3).locator(".series-grip"), group(page, 2), "below");
  await expect(toast(page, "Moved 2 attempts · numbers updated")).toBeVisible();
  await expectOrder(page, sid, [a1, a2, a5, b1, a3, a4]);
  expect(await pills(page)).toEqual([3, 2, 1]);
  await page.locator(".series-select-bar").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".series-select-bar")).toHaveCount(0);
});

test("move up / down jump whole versions; before… / after… use the picker", async ({ page }) => {
  // The design's example: v1 = A #1–3, v2 = B #4–6.
  const { sid, ids } = await seed(page, "Menu test", "AAABBB");
  const [a1, a2, a3, b1, b2, b3] = ids;
  await openApp(page);
  await openSeries(page, "Menu test");

  // Inside a version: one slot.
  await group(page, 1).getByRole("button", { name: "3 attempts" }).click();
  await rowMenu(page, 2, "Move up");
  await expectOrder(page, sid, [a1, a3, a2, b1, b2, b3]);
  // At the version's edge: past the whole neighbour, which stays whole.
  await rowMenu(page, 3, "Move up");
  await expectOrder(page, sid, [a1, a3, b1, b2, b3, a2]);
  expect(await pills(page)).toEqual([3, 2, 1]);
  await expect(group(page, 2).locator(".series-vg-head")).toContainText("3 tries");
  // And back down: the lone A jumps the whole B version again and merges.
  await groupMenu(page, 3, "Move down");
  await expectOrder(page, sid, [a1, a3, a2, b1, b2, b3]);
  expect(await pills(page)).toEqual([2, 1]);
  // Ends are disabled.
  await group(page, 2).locator(".series-vg-head").getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Move before…: the picker lists every version; the moving one is disabled.
  await groupMenu(page, 2, "Move before…");
  const picker = page.getByRole("dialog", { name: "Move before…" });
  await expect(picker.locator(".series-mp-version")).toHaveCount(2);
  await expect(picker.locator(".series-mp-version", { hasText: "v2" })).toBeDisabled();
  await picker.locator(".series-mp-version", { hasText: "v1" }).click();
  await expectOrder(page, sid, [b1, b2, b3, a1, a3, a2]);

  // Move after…: search "#5", then a single attempt as the target.
  await groupMenu(page, 1, "Move after…");
  const after = page.getByRole("dialog", { name: "Move after…" });
  await after.getByRole("searchbox").fill("#5");
  await expect(after.locator(".series-mp-version")).toHaveCount(1);
  await after.locator(".series-mp-attempt", { hasText: "#5" }).click();
  await expectOrder(page, sid, [a1, a3, b1, b2, b3, a2]);
});

test("⌥↑ / ⌥↓ move the selection", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit maps ⌥ arrows to text navigation; covered in Chromium");
  const { sid, ids } = await seed(page, "Keys test", "AAB");
  const [a1, a2, b1] = ids;
  await openApp(page);
  await openSeries(page, "Keys test");
  await page.locator(".series-detail-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Select" }).click();
  await page.getByRole("checkbox", { name: "Select #1" }).first().click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => order(page, sid)).toEqual([a2, a1, b1]);
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => order(page, sid)).toEqual([a1, a2, b1]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".series-select-bar")).toHaveCount(0);
});

test("reset to time order applies at once; Undo restores the custom order", async ({ page }) => {
  const { sid, ids } = await seed(page, "Reset test", "AB");
  const [a1, b1] = ids;
  await openApp(page);
  await openSeries(page, "Reset test");
  await groupMenu(page, 1, "Move up");
  await expectOrder(page, sid, [b1, a1]);
  await expect(page.locator(".series-order-chip")).toBeVisible();

  await page.getByRole("button", { name: "Reset to time order" }).click();
  // No confirm dialog: applied immediately.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const t = toast(page, "Back to time order · numbers updated");
  await expect(t).toBeVisible();
  await expect.poll(() => order(page, sid)).toEqual([a1, b1]);
  await expect(page.locator(".series-order")).toHaveText("Newest first");

  await t.getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Custom order restored")).toBeVisible();
  await expect.poll(() => order(page, sid)).toEqual([b1, a1]);
  await expect(page.locator(".series-order-chip")).toBeVisible();
});

test("a failed move rolls back; History stays in time order", async ({ page }) => {
  const { sid, ids } = await seed(page, "Fail test", "AB");
  const [a1, b1] = ids;
  await openApp(page);
  await openSeries(page, "Fail test");
  await page.route("**/api/series/*/reorder", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "disk full" }) }),
  );
  await groupMenu(page, 2, "Move down");
  await expect(toast(page, "disk full")).toBeVisible();
  expect(await pills(page)).toEqual([2, 1]);
  await expect(group(page, 2).locator(".series-vg-num")).toHaveText("#2");
  await expectOrder(page, sid, [a1, b1]);
  await page.unroute("**/api/series/*/reorder");

  // A real move, then History: still newest first by time.
  await groupMenu(page, 2, "Move down");
  await expect.poll(() => order(page, sid)).toEqual([b1, a1]);
  const hist = await (await page.request.get("/api/generations?limit=200")).json();
  const mine = (hist.generations as { id: number }[]).map((g) => g.id).filter((id) => ids.includes(id));
  expect(mine).toEqual([b1, a1]);
});

test("phone: no drag, the menu and a picker sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { sid, ids } = await seed(page, "Phone test", "AAB");
  const [a1, a2, b1] = ids;
  await page.goto("/");
  await expect(page.locator(".phone-tabs")).toBeVisible();
  await openSeries(page, "Phone test");
  await expect(page.locator(".series-grip")).toHaveCount(0);
  await groupMenu(page, 2, "Move before…");
  const sheet = page.getByRole("dialog", { name: "Move before…" });
  await expect(sheet).toBeVisible();
  const v1 = sheet.locator(".series-mp-version", { hasText: "v1" });
  expect((await v1.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await v1.click();
  await expect.poll(() => order(page, sid)).toEqual([b1, a1, a2]);
  // Reset lives in ⋯ on narrow layouts.
  await page.locator(".series-detail-phonebar").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset to time order" }).click();
  await expect.poll(() => order(page, sid)).toEqual([a1, a2, b1]);
});
