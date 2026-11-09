import { type Locator, type Page } from "@playwright/test";
import {
  contextMenu,
  expect,
  libraryTiles,
  menuLabels,
  openApp,
  rightClick,
  sidebarTab,
  submenu,
  test,
} from "../fixtures";
import { queueCard, submitPrompt } from "../queue";
import { openViewerOn, shownLibTile, viewer } from "../ui";

// series-v2 B1a: SeriesBadge, SeriesInfoCard, the shared "Open “X”" menu row,
// the Viewer's series context and the Library move confirmation.
//
// Fixture series (desktop/scripts/e2e_build_library.py, section 9):
//   Autumn campaign / Perfume poster   = the g1→g4 poster chain (#1–#4) + the pinned poster draft
//   Autumn campaign / Lookbook cover   = imported run 1 (#1) + the flat-lay fork (#2)
//   Brand / Logo sticker set           = imported run 2 (#1) + mascot tries 1–2 (#2, #3)
// landscape-dunes.jpg is the output of imported runs 1 and 2 (two series);
// landscape-alps.jpg is an input of the poster's #3 and of imported run 2.

const PERFUME = "Series: Autumn campaign / Perfume poster";
const FINAL_POSTER = "Final poster: combine all three iterations into a triptych";

const card = (page: Page) => page.locator(".sv2-popover");
const historyRecord = (page: Page, text: string) => page.getByRole("article").filter({ hasText: text }).first();

/** Right-click after any scroll settled (menus close on scroll). */
async function rightClickSettled(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))),
  );
  await rightClick(target);
}

async function openHistoryRecord(page: Page, text: string) {
  await sidebarTab(page, "History");
  // A short query: a search box whose text overflows scrolls on blur, and
  // that scroll event closes a context menu opened right after it.
  await page.getByPlaceholder("Search prompt…").fill(text.split(" ").slice(-1)[0]);
  const item = historyRecord(page, text);
  await expect(item).toBeVisible();
  // The search refreshes the list (which closes menus): wait until it settled.
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  await page.waitForTimeout(300);
  return item;
}

test.describe("read-only", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test("badge is a button: click and hover open the info card", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    const badge = item.getByRole("button", { name: PERFUME });
    await expect(badge).toHaveAttribute("aria-haspopup", "dialog");

    // Click: opens immediately, shows the record's place in the series.
    await badge.click();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Autumn campaign /");
    await expect(card(page)).toContainText("Perfume poster");
    await expect(card(page)).toContainText("4 tries · 100% ok");
    await expect(card(page).locator(".sv2-card-record")).toHaveText(/This record\s*#4/);
    // The click did not open the viewer behind the badge.
    await expect(viewer(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(badge).toBeFocused();

    // Hover: opens after ~400 ms, closes shortly after the pointer leaves.
    await page.mouse.move(5, 5);
    await badge.hover();
    await expect(card(page)).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(card(page)).toHaveCount(0);
  });

  test("info card: Open series shows the detail", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Open series" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Series" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".series-detail h2")).toHaveText("Perfume poster");
  });

  test("info card: Change series opens the picker in place", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Change series…" }).click();
    await expect(card(page).getByPlaceholder(/Search/)).toBeVisible();
    await expect(card(page)).toContainText("Logo sticker set");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
  });

  test("every list offers Open “series” in its context menu", async ({ page }) => {
    // History
    let item = await openHistoryRecord(page, FINAL_POSTER);
    await rightClickSettled(page, item.getByRole("button").first());
    let labels = await menuLabels(page);
    expect(labels.indexOf("Open “Perfume poster”")).toBe(labels.indexOf("Add to series") - 1);
    await page.keyboard.press("Escape");

    // Favorites (images: badge + menu)
    await sidebarTab(page, "Favorites");
    item = page.getByRole("article").filter({ hasText: "Same composition, swap background" });
    await expect(item.getByRole("button", { name: PERFUME })).toBeVisible();
    await rightClickSettled(page, item.getByRole("button", { name: "poster-alps-4k.png", exact: true }));
    expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Open “Perfume poster”", "Add to series"]));
    await page.keyboard.press("Escape");

    // Drafts (badge in the footer row + menu)
    await sidebarTab(page, "Drafts");
    item = page.getByRole("article").filter({ hasText: "下一版海报" });
    await expect(item.getByRole("button", { name: PERFUME })).toBeVisible();
    await rightClickSettled(page, item.getByRole("button", { name: "poster-alps-4k.png", exact: true }).first());
    expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Open “Perfume poster”", "Add to series"]));
    await page.keyboard.press("Escape");

    // Library (image in two series → "Open series ›" with both paths)
    await sidebarTab(page, "Library");
    await expect(libraryTiles(page).first()).toBeVisible();
    await rightClick(await shownLibTile(page, "landscape-dunes.jpg"));
    await contextMenu(page).getByRole("menuitem", { name: /Open series/ }).hover();
    await expect(submenu(page)).toContainText("Autumn campaign / Lookbook cover");
    await expect(submenu(page)).toContainText("Brand / Logo sticker set");
    await page.keyboard.press("Escape");

    // Viewer
    await openViewerOn(page, "poster-alps-4k.png");
    await rightClick(viewer(page).getByRole("img", { name: "poster-alps-4k.png" }));
    expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Open “Perfume poster”", "Add to series"]));
  });

  test("viewer lists every series, primary first; inputs count", async ({ page }) => {
    await openViewerOn(page, "landscape-alps.jpg");
    const block = viewer(page).locator(".sv2-viewer-series");
    await expect(block.getByRole("heading")).toHaveText("Series · 2");
    const rows = block.locator(".sv2-viewer-row");
    await expect(rows).toHaveCount(2);
    // Primary = most recently used: the poster's #3 used it as an input.
    await expect(rows.nth(0)).toContainText("Perfume poster");
    await expect(rows.nth(0)).toContainText("input of #3");
    await expect(rows.nth(1)).toContainText("Logo sticker set");
    await expect(rows.nth(1)).toContainText("input of #1");
    // The block sits above Prompt.
    const order = await viewer(page)
      .locator(".viewer-sections > section")
      .evaluateAll((els) => els.map((el) => el.className));
    expect(order[0]).toContain("sv2-viewer-series");

    // A row opens that series (and closes the viewer).
    await rows.nth(1).click();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page.locator(".series-detail h2")).toHaveText("Logo sticker set");
  });

  test("an image output by two series shows both", async ({ page }) => {
    await openViewerOn(page, "landscape-dunes.jpg");
    const rows = viewer(page).locator(".sv2-viewer-series .sv2-viewer-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Lookbook cover");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("Logo sticker set");
  });

  test("opened from a series, the viewer pages in series order", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Open series" }).click();
    await page.locator(".series-film-item").first().click();
    const strip = viewer(page).locator(".sv2-viewer-strip");
    await expect(strip).toHaveText("Perfume poster · #1 of 4");
    await expect(viewer(page).locator(".viewer-count")).toHaveText("1 / 4");
    await page.keyboard.press("ArrowRight");
    await expect(strip).toHaveText("Perfume poster · #2 of 4");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(strip).toHaveText("Perfume poster · #4 of 4");
    // The strip opens the info card fixed to this series.
    await strip.click();
    await expect(card(page)).toContainText("Perfume poster");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(viewer(page)).toBeVisible();
  });

  test("library: filing an image that is in another series asks first", async ({ page }) => {
    await rightClick(await shownLibTile(page, "poster-alps-4k.png"));
    await contextMenu(page).getByRole("menuitem", { name: "Add to series" }).hover();
    await submenu(page).getByText("Logo sticker set").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Move 1 record to Logo sticker set?");
    await expect(dialog).toContainText("1 record will move from Perfume poster");
    await expect(contextMenu(page)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    // Nothing moved.
    const res = await page.request.get("/api/generations/series-position?ids=3").then((r) => r.json());
    expect(res.items[0].seq).toBe(3);
  });

  test("library tiles show series dots on hover", async ({ page }) => {
    const tile = (await shownLibTile(page, "landscape-dunes.jpg")).locator("..");
    const dots = tile.locator(".lib-series");
    await expect(dots).toHaveAttribute("title", "Lookbook cover · Logo sticker set");
    await expect(dots).toHaveCSS("opacity", "0");
    await tile.hover();
    await expect(dots).toHaveCSS("opacity", "1");
  });

  test("a library switch never reopens the old series", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Open series" }).click();
    await expect(page.locator(".series-detail h2")).toHaveText("Perfume poster");
    // Another library: a different key, and series ids that mean nothing here.
    await page.route("**/api/settings/library", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, key: "another-library" } });
    });
    await page.route("**/api/series?*", (route) => route.fulfill({ json: { themes: [], unthemed: [] } }));
    await page.reload();
    await page.getByRole("tab", { name: "Series" }).click();
    await expect(page.locator(".series-detail")).toHaveCount(0);
  });
});

test.describe("changes data", () => {
  test.use({ freshLibrary: true });

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test("remove from series, then undo", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Remove from series" }).click();
    const toast = page.getByText("Removed from Perfume poster");
    await expect(toast).toBeVisible();
    await expect(item.getByRole("button", { name: PERFUME })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(item.getByRole("button", { name: PERFUME })).toBeVisible();
  });

  test("from a series, Prompt shows that series' record, not the image's newest one", async ({ page }) => {
    // poster-alps-4k.png is #3 of Perfume poster (generation 3). A newer
    // Lookbook cover record outputs the same image.
    const ALPS_PROMPT = "Same composition, swap background for the alpine landscape";
    const LOOKBOOK_PROMPT = "Lookbook cover reuses the alpine poster";
    const tree = await page.request.get("/api/series").then((r) => r.json());
    const lookbook = tree.themes
      .flatMap((theme: { series: { id: number; name: string }[] }) => theme.series)
      .find((node: { name: string }) => node.name === "Lookbook cover").id;
    const g3 = await page.request.get("/api/generations/3").then((r) => r.json());
    expect(g3.prompt).toBe(ALPS_PROMPT);
    const created = await page.request.post("/api/generations/manual", {
      data: {
        prompt: LOOKBOOK_PROMPT,
        model: "gemini-3-pro-image",
        status: "success",
        outputImageId: g3.output_image_id,
        seriesId: lookbook,
      },
    });
    expect(created.ok()).toBe(true);
    await openApp(page);

    // Without a series context the viewer keeps showing the newest record.
    await openViewerOn(page, "poster-alps-4k.png");
    await expect(viewer(page).locator(".viewer-prompt-text")).toHaveText(LOOKBOOK_PROMPT);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);

    // From Perfume poster: the strip says #3, and Prompt is #3's prompt.
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Open series" }).click();
    await page.locator(".series-film-item").nth(2).click();
    const strip = viewer(page).locator(".sv2-viewer-strip");
    const prompt = viewer(page).locator(".viewer-prompt-text");
    await expect(strip).toHaveText("Perfume poster · #3 of 4");
    await expect(prompt).toHaveText(ALPS_PROMPT);
    await expect(viewer(page).locator(".viewer-params")).toContainText("16:9");
    // Paging away and back keeps it.
    await page.keyboard.press("ArrowRight");
    await expect(strip).toHaveText("Perfume poster · #4 of 4");
    await expect(prompt).toHaveText(FINAL_POSTER);
    await page.keyboard.press("ArrowLeft");
    await expect(strip).toHaveText("Perfume poster · #3 of 4");
    await expect(prompt).toHaveText(ALPS_PROMPT);
  });

  test("queue cards carry the badge and the series menu", async ({ page }) => {
    const item = await openHistoryRecord(page, FINAL_POSTER);
    await item.getByRole("button", { name: PERFUME }).click();
    await card(page).getByRole("button", { name: "Open in workspace" }).click();
    // The History search box would also match the composer's "Prompt" field.
    await sidebarTab(page, "Library");
    await submitPrompt(page, "Poster variant for the queue badge");
    const queued = queueCard(page, "Poster variant for the queue badge");
    await expect(queued.getByRole("button", { name: PERFUME })).toBeVisible();
    const output = queued.locator(".hcard-media img");
    await expect(output).toBeVisible({ timeout: 20_000 });
    await rightClickSettled(page, output);
    expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Open “Perfume poster”", "Add to series"]));
    await page.keyboard.press("Escape");
    // The finished record is #5 of the series.
    await queued.getByRole("button", { name: PERFUME }).click();
    await expect(card(page).locator(".sv2-card-record")).toHaveText(/This record\s*#5/);
  });
});
