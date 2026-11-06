import type { Locator, Page } from "@playwright/test";
import { contextMenu, expect, test } from "../fixtures";
import { expectNoHorizontalScroll, libTile } from "../ui";

// Phone layout (375×812, touch). Runs only in the "mobile" project.

async function touchPoint(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real touch long-press (Chromium CDP), so pointer events carry pointerType "touch". */
async function longPress(page: Page, target: Locator, ms = 700) {
  const { x, y } = await touchPoint(target);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function tap(page: Page, target: Locator) {
  const { x, y } = await touchPoint(target);
  await page.touchscreen.tap(x, y);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await expect(libTile(page, "landscape-alps.jpg")).toBeVisible();
});

test("long-press a thumbnail enters multi-select", async ({ page }) => {
  await longPress(page, libTile(page, "landscape-alps.jpg"));
  const selected = page.locator(".library-grid .lib-tile.selected");
  await expect(selected).toHaveCount(1);
  await expect(page.locator(".library-grid .lib-tile.selecting").first()).toBeVisible();
  // No viewer and no custom context menu from the long-press.
  await expect(page.locator(".viewer-overlay")).toHaveCount(0);
  await expect(contextMenu(page)).toHaveCount(0);
  // A second tap extends the selection.
  await tap(page, libTile(page, "landscape-dunes.jpg"));
  await expect(selected).toHaveCount(2);
});

test("tap opens the viewer; no hover preview is left behind", async ({ page }) => {
  await tap(page, libTile(page, "landscape-alps.jpg"));
  const v = page.locator(".viewer-overlay");
  await expect(v).toBeVisible();
  await expect(v.getByRole("img", { name: "landscape-alps.jpg" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect(v).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page.locator(".hover-peek")).toHaveCount(0);

  // History input chips have hover previews on desktop; a tap must not leave one stuck.
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "History" }).click();
  const chip = page.getByRole("article").filter({ hasText: "Sneaker on dunes at golden hour" }).getByRole("button", {
    name: "landscape-dunes.jpg",
    exact: true,
  });
  await tap(page, chip);
  await expect(v).toBeVisible();
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect(v).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page.locator(".hover-peek")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("no horizontal scrolling on the main sections", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expectNoHorizontalScroll(page);
  for (const section of ["Generate", "History", "Library"]) {
    await nav.getByRole("button", { name: section, exact: true }).click();
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  }
});
