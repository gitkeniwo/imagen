import { expect, type Locator, type Page } from "@playwright/test";

/** A library thumbnail (sidebar grid) by its display name. */
export const libTile = (page: Page, name: string | RegExp) =>
  page.locator(".library-grid").getByRole("button", { name, exact: typeof name === "string" }).first();

export const libTiles = (page: Page) => page.locator(".library-grid .lib-tile > img");

/** The left sidebar (Library / History / Favorites / Drafts). */
export const sidebar = (page: Page) => page.getByRole("complementary").filter({ has: page.getByRole("tablist") });

/** The open image viewer (the last one when viewers are nested). */
export const viewer = (page: Page) => page.locator(".viewer-overlay").last();

export const referenceTray = (page: Page) => page.locator(".tray").first();

export const viewerTitle = (page: Page) =>
  viewer(page).getByRole("complementary", { name: "Image info" }).getByRole("heading", { level: 2 });

export async function openViewerOn(page: Page, name: string) {
  await libTile(page, name).click();
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
