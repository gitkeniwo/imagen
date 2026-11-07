import { expect, type Locator, type Page } from "@playwright/test";

/** A library thumbnail (sidebar grid) by its display name. */
export const libTile = (page: Page, name: string | RegExp) =>
  page.locator(".library-grid").getByRole("button", { name, exact: typeof name === "string" }).first();

/**
 * The Library grid is virtualized: only rows near the viewport exist in the
 * DOM. Scrolls the library until the tile is rendered, then returns it
 * (scrolled into view). Use for any tile that may sit below the first screen.
 */
export async function shownLibTile(page: Page, name: string | RegExp): Promise<Locator> {
  const tile = libTile(page, name);
  const grid = page.locator(".library-vgrid").first();
  await expect(grid).toBeAttached();
  const scroll = (to: "top" | "down") =>
    grid.evaluate((el, how) => {
      let s: HTMLElement | null = el.parentElement;
      while (s) {
        const oy = getComputedStyle(s).overflowY;
        if ((oy === "auto" || oy === "scroll") && s.scrollHeight > s.clientHeight) break;
        s = s.parentElement;
      }
      const scroller = s ?? document.scrollingElement!;
      const before = scroller.scrollTop;
      if (how === "top") scroller.scrollTop = 0;
      else scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.6);
      return scroller.scrollTop !== before;
    }, to);
  if ((await tile.count()) === 0) {
    await scroll("top");
    for (let i = 0; i < 100; i++) {
      // Rows render on scroll; their data arrives after a short debounce.
      await page.waitForTimeout(120);
      if ((await tile.count()) > 0) break;
      if (!(await scroll("down"))) {
        await page.waitForTimeout(300);
        break;
      }
    }
  }
  await expect(tile).toBeAttached();
  await tile.scrollIntoViewIfNeeded();
  // Context menus close on scroll: let the scroll events above fire (they
  // are dispatched on the next frames) before the caller opens one.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))),
  );
  return tile;
}

export const libTiles = (page: Page) => page.locator(".library-grid .lib-tile > img");

/** The left sidebar (Library / History / Favorites / Drafts). */
export const sidebar = (page: Page) => page.getByRole("complementary").filter({ has: page.getByRole("tablist") });

/** The open image viewer (the last one when viewers are nested). */
export const viewer = (page: Page) => page.locator(".viewer-overlay").last();

export const referenceTray = (page: Page) => page.locator(".tray").first();

export const viewerTitle = (page: Page) =>
  viewer(page).getByRole("complementary", { name: "Image info" }).getByRole("heading", { level: 2 });

export async function openViewerOn(page: Page, name: string) {
  await (await shownLibTile(page, name)).click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewerTitle(page)).toHaveText(name);
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

export async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}
