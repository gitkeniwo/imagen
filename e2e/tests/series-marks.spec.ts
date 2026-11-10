import type { Page } from "@playwright/test";
import { expect, openApp, test } from "../fixtures";

// series-v2 B6: picks / rejects / cover in the series detail, the top strip,
// series cards, InfoCard, Viewer and image context menus.

test.use({ freshLibrary: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.innerWidth >= 640) localStorage.setItem("imagen-sidebar-width", "760");
  });
});

interface Seed {
  sid: number;
  ids: number[];
  outputs: number[];
  titles: string[];
}

/** Six one-attempt versions with distinct prompts and outputs. */
async function seed(page: Page): Promise<Seed> {
  const theme = await (
    await page.request.post("/api/series", { data: { kind: "theme", name: "Marks theme" } })
  ).json();
  const series = await (
    await page.request.post("/api/series", {
      data: { kind: "series", name: "Marks test", parentId: theme.id, color: "#0891b2" },
    })
  ).json();
  const images = ((await (await page.request.get("/api/images?limit=10")).json()).images as {
    id: number;
  }[]).map((img) => img.id);
  const titles = ["Marks A", "Marks B", "Marks C", "Marks D", "Marks E", "Marks F"];
  const ids: number[] = [];
  const outputs: number[] = [];
  const start = Date.now() - 24 * 3600_000;
  for (const [i, prompt] of titles.entries()) {
    const res = await page.request.post("/api/generations/manual", {
      data: {
        prompt,
        model: "gemini-3-pro-image",
        aspectRatio: "4:5",
        resolution: "2K",
        status: "success",
        source: "vertex",
        inputImageIds: [images[0]],
        outputImageId: images[i + 1],
        createdAt: new Date(start + (i + 1) * 60_000).toISOString(),
        seriesId: series.id,
      },
    });
    expect(res.ok()).toBeTruthy();
    ids.push((await res.json()).id);
    outputs.push(images[i + 1]);
  }
  return { sid: series.id, ids, outputs, titles };
}

async function openSeries(page: Page) {
  const tab = page.getByRole("tab", { name: "Series", exact: true });
  if (await tab.isVisible()) await tab.click();
  else await page.locator(".phone-tabs").getByRole("button", { name: "Series" }).click();
  const title = page.locator(".series-detail h2");
  if (!(await title.isVisible())) {
    await page.getByRole("button", { name: "Marks test", exact: true }).first().click();
  }
  await expect(title).toHaveText("Marks test");
}

async function backToList(page: Page) {
  await page.locator(".series-crumbs").getByRole("button", { name: "Series" }).click();
}

const group = (page: Page, k: number) => page.locator(`.series-vg[data-version="${k}"]`);

async function seriesState(page: Page, sid: number) {
  const detail = await (await page.request.get(`/api/series/${sid}`)).json();
  return {
    picks: detail.picks as number,
    cover: (detail.cover_image?.id ?? null) as number | null,
    explicitCover: (detail.cover_image_id ?? null) as number | null,
    marks: Object.fromEntries(
      (detail.outputs as { image: { id: number; mark: string | null } }[]).map((row) => [
        row.image.id,
        row.image.mark,
      ]),
    ) as Record<number, string | null>,
  };
}

async function toggleMark(page: Page, k: number, label: "Pick" | "Reject") {
  const tile = group(page, k).locator(".series-vg-thumb-wrap");
  await tile.hover();
  await group(page, k).getByRole("button", { name: label, exact: true }).click();
}

async function groupMenu(page: Page, k: number, item: string) {
  await group(page, k).locator(".series-vg-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("detail marks, cover fallback, filters, clear all and ★N", async ({ page }) => {
  const { sid, outputs, titles } = await seed(page);
  await openApp(page);
  await openSeries(page);

  await expect(page.locator(".series-picks-caption")).toContainText("No picks yet");
  await toggleMark(page, 6, "Pick");
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]]).toBe("pick");
  await expect(page.locator(".series-picks-caption")).toContainText("1 pick");

  await toggleMark(page, 5, "Pick");
  await expect.poll(async () => (await seriesState(page, sid)).picks).toBe(2);
  await expect(page.locator(".series-picks-caption")).toContainText("2 picks");
  // No explicit cover: the latest pick (#5) is the cover.
  await expect.poll(async () => (await seriesState(page, sid)).cover).toBe(outputs[4]);
  await expect(page.locator(".series-cover figcaption")).toHaveText("Cover · #5");

  // Set an explicit cover, then clear it and fall back to the latest pick.
  await groupMenu(page, 6, "Set as cover");
  await expect.poll(async () => (await seriesState(page, sid)).cover).toBe(outputs[5]);
  await expect(page.locator(".series-cover figcaption")).toHaveText("Cover · #6");
  await groupMenu(page, 6, "Clear cover");
  await expect.poll(async () => (await seriesState(page, sid)).cover).toBe(outputs[4]);
  await expect(page.locator(".series-cover figcaption")).toHaveText("Cover · #5");

  // Reject is one mark per image: the thumbnail fades and the filter hides
  // every version without a rejected output.
  await toggleMark(page, 2, "Reject");
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[1]]).toBe("reject");
  await expect(group(page, 2).locator(".series-vg-thumb-wrap")).toHaveClass(/rejected/);
  await page.getByRole("button", { name: "Rejected 1" }).click();
  await expect(group(page, 2)).toHaveCount(1);
  await expect(page.locator(".series-vg-hidden")).toHaveCount(5);
  await page.getByRole("button", { name: /^Attempts/ }).click();
  await expect(page.locator(".series-timeline > .series-row")).toHaveCount(1);
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: "All 6" }).click();

  // Series card meta gets ★N.
  await backToList(page);
  const card = page.locator(".series-card").filter({ hasText: "Marks test" }).first();
  await expect(card.locator(".series-picks-count")).toHaveText("2");

  // InfoCard marks the image itself as a pick.
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByPlaceholder("Search prompt…").fill(titles[4]);
  const record = page.getByRole("article").filter({ hasText: titles[4] }).first();
  await expect(record).toBeVisible();
  await record.getByRole("button", { name: "Series: Marks theme / Marks test" }).click();
  await expect(page.locator(".sv2-popover .sv6-pick-mark")).toBeVisible();
  await page.keyboard.press("Escape");

  // Clear all picks asks first; rejects and the cover stay.
  await page.getByRole("tab", { name: "Series", exact: true }).click();
  await openSeries(page);
  await page.locator(".series-detail-head").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clear all picks" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Clear all 2 picks?");
  await dialog.getByRole("button", { name: "Clear picks" }).click();
  await expect(page.locator(".toast").filter({ hasText: "2 picks cleared" })).toBeVisible();
  await expect.poll(async () => (await seriesState(page, sid)).picks).toBe(0);
  await expect(page.locator(".series-picks-caption")).toContainText("No picks yet");
  expect((await seriesState(page, sid)).marks[outputs[1]]).toBe("reject");
});

test("Viewer and image context menu toggle the same marks", async ({ page }) => {
  const { sid, outputs, titles } = await seed(page);
  await openApp(page);
  await openSeries(page);
  await toggleMark(page, 6, "Pick");
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]]).toBe("pick");

  await page.locator(".series-picks .series-pick-item").first().click();
  const viewer = page.locator(".viewer-overlay").last();
  await expect(viewer.locator(".series-mark-toggles")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Picked" })).toHaveAttribute("aria-pressed", "true");
  await viewer.getByRole("button", { name: "Set as cover", exact: true }).click();
  await expect.poll(async () => (await seriesState(page, sid)).explicitCover).toBe(outputs[5]);
  await expect(viewer.getByRole("button", { name: "Cover", exact: true })).toHaveAttribute("aria-pressed", "true");
  await viewer.getByRole("button", { name: "Cover", exact: true }).click();
  await expect.poll(async () => (await seriesState(page, sid)).explicitCover).toBe(null);
  await viewer.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]]).toBe("reject");
  await expect(viewer.getByRole("button", { name: "Rejected" })).toHaveAttribute("aria-pressed", "true");
  // Clicking the active mark clears it; clicking Reject again restores it.
  await viewer.getByRole("button", { name: "Rejected" }).click();
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]] ?? null).toBe(null);
  await viewer.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]]).toBe("reject");
  await viewer.getByRole("button", { name: "Close" }).click();

  await page.getByRole("tab", { name: "History" }).click();
  await page.getByPlaceholder("Search prompt…").fill(titles[5]);
  const record = page.getByRole("article").filter({ hasText: titles[5] }).first();
  await expect(record).toBeVisible();
  await record.locator(".hcard-media img").click({ button: "right" });
  const marks = page.locator(".context-series-marks");
  await expect(marks).toContainText("In Marks test");
  await expect(marks.getByRole("menuitem", { name: "Clear reject" })).toHaveAttribute("aria-pressed", "true");
  await marks.getByRole("menuitem", { name: "Pick", exact: true }).click();
  await expect.poll(async () => (await seriesState(page, sid)).marks[outputs[5]]).toBe("pick");
});
