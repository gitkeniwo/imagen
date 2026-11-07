import { contextMenu, expect, openApp, rightClick, submenu, test } from "../fixtures";
import { libTile, shownLibTile, openViewerOn, viewer, viewerTitle } from "../ui";

// Read-only: menus are opened and dismissed without choosing an action.

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

const focusedItem = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.closest(".context-menu")) return null;
    return (
      el.getAttribute("aria-label") ||
      el.querySelector(".context-menu-label, span:not(.context-check)")?.textContent?.trim() ||
      ""
    );
  });

test("Shift+F10 opens the menu, arrows cycle, → / ← enter and leave the tag submenu, Esc returns focus", async ({
  page,
}) => {
  const tile = (await shownLibTile(page, "landscape-alps.jpg"));
  // Scroll first: the menu closes on scroll, and focus() may scroll the grid.
  await tile.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await tile.focus();
  await expect(tile).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press("Shift+F10");
  await expect(contextMenu(page)).toBeVisible();
  // Focus starts on the first item.
  await expect.poll(() => focusedItem(page)).toBe("View");

  const order = ["View", "Add to input", "Favorite", "Download", "Tags", "Move to Bin"];
  for (const name of order.slice(1)) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedItem(page)).toBe(name);
  }
  // Down from the last item wraps to the first; Up from the first to the last.
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedItem(page)).toBe("View");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedItem(page)).toBe("Move to Bin");

  // → on "Tags" opens the submenu and moves focus into it; ← goes back.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedItem(page)).toBe("Tags");
  await page.keyboard.press("ArrowRight");
  await expect(submenu(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".context-menu-submenu"))).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(submenu(page)).toHaveCount(0);
  await expect(contextMenu(page)).toBeVisible();
  await expect.poll(() => focusedItem(page)).toBe("Tags");

  // Esc closes the menu and focus returns to the thumbnail.
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
  await expect(tile).toBeFocused();
});

test("in the viewer, ← / → / i with the menu open leave the image and panel alone", async ({ page }) => {
  await openViewerOn(page, "landscape-alps.jpg");
  const v = viewer(page);
  const counter = v.getByText(/^\d+ \/ \d+$/);
  const position = await counter.innerText();
  const info = v.getByRole("complementary", { name: "Image info" });
  await expect(info).toBeVisible();

  await rightClick(v.getByRole("img", { name: "landscape-alps.jpg" }));
  await expect(contextMenu(page)).toBeVisible();
  for (const key of ["ArrowLeft", "ArrowRight", "i", "ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(key);
  }
  await expect(viewerTitle(page)).toHaveText("landscape-alps.jpg");
  await expect(counter).toHaveText(position);
  await expect(info).toBeVisible();

  // Sanity: without the menu the same keys do act on the viewer.
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
  await expect(v).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(counter).not.toHaveText(position);
});
