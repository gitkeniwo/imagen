import {
  contextMenu,
  expect,
  menuLabels,
  menuTitle,
  openApp,
  rightClick,
  sidebarTab,
  submenu,
  test,
  watchContextMenuDefault,
} from "../fixtures";
import { libTile, shownLibTile, viewer, openViewerOn, referenceTray } from "../ui";

// Read-only checks (menus are opened and dismissed); one library per file.

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("library thumbnail menu matches the image", async ({ page }) => {
  // A generated image is titled by its prompt, an upload by its name.
  await rightClick((await shownLibTile(page, "poster-alps-4k.png")));
  await expect.poll(() => menuTitle(page)).toBe("Same composition, swap background for the alpine landscape");
  const labels = await menuLabels(page);
  expect(labels).toEqual([
    "View",
    "Add to input",
    "Unfavorite",
    "Download",
    "Pick",
    "Reject",
    "Set as cover",
    "Copy image",
    "Tags",
    "Open “Perfume poster”",
    "Add to series",
    "Move to Bin",
  ]);
  await expect(contextMenu(page)).toContainText("2400×1350 · PNG · Generated");
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);

  await rightClick((await shownLibTile(page, "landscape-alps.jpg")));
  expect(await menuTitle(page)).toBe("landscape-alps.jpg");
  expect(await menuLabels(page)).toEqual([
    "View",
    "Add to input",
    "Favorite",
    "Download",
    "Copy image",
    "Tags",
    // An input of records in two series (series-v2 B1a).
    "Open series",
    "Add to series",
    "Move to Bin",
  ]);
  await expect(contextMenu(page)).toContainText("1920×1080 · JPEG · Uploaded");
});

test("history item menu carries the generation actions", async ({ page }) => {
  await sidebarTab(page, "History");
  await page.getByPlaceholder("Search prompt…").fill("Sneaker on dunes");
  const item = page.getByRole("article").filter({ hasText: "Sneaker on dunes at golden hour" });
  await rightClick(item.getByRole("button").first());
  expect(await menuTitle(page)).toBe("Sneaker on dunes at golden hour");
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["View", "Download", "Copy prompt", "Reuse", "Rerun"]));
});

test("favorites menu", async ({ page }) => {
  await sidebarTab(page, "Favorites");
  const item = page.getByRole("article").filter({ hasText: "Same composition, swap background" });
  // The output carries the record actions...
  await rightClick(item.getByRole("button", { name: "poster-alps-4k.png", exact: true }));
  expect(await menuTitle(page)).toBe("Same composition, swap background for the alpine landscape");
  expect(await menuLabels(page)).toEqual(
    expect.arrayContaining(["View", "Unfavorite", "Download", "Copy prompt", "Reuse", "Rerun"]),
  );
  await page.keyboard.press("Escape");
  // ...an input of the same record does not.
  await rightClick(item.getByRole("button", { name: "landscape-alps.jpg", exact: true }));
  expect(await menuTitle(page)).toBe("landscape-alps.jpg");
  const inputLabels = await menuLabels(page);
  expect(inputLabels).toEqual(expect.arrayContaining(["View", "Favorite", "Download"]));
  expect(inputLabels).not.toContain("Copy prompt");
});

test("drafts menu", async ({ page }) => {
  await sidebarTab(page, "Drafts");
  const draft = page.getByRole("article").filter({ hasText: "Sneaker campaign — try a night version" });
  await rightClick(draft.getByRole("button", { name: /^Generated · / }));
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["View", "Download"]));
});

test("viewer main image and input image menus", async ({ page }) => {
  await openViewerOn(page, "poster-alps-4k.png");
  const v = viewer(page);
  await rightClick(v.getByRole("img", { name: "poster-alps-4k.png" }));
  await expect.poll(() => menuTitle(page)).toBe("Same composition, swap background for the alpine landscape");
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Add to input", "Download", "Copy image", "Tags", "Move to Bin"]));
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
  await expect(v).toBeVisible();

  await rightClick(v.getByRole("button", { name: "landscape-alps.jpg · Open this input in the viewer" }));
  expect(await menuTitle(page)).toBe("landscape-alps.jpg");
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["Add to input", "Download", "Copy image"]));
  await expect(contextMenu(page)).toContainText("1920×1080 · JPEG · Uploaded");
});

test("reference tray menu", async ({ page }) => {
  await rightClick((await shownLibTile(page, "landscape-alps.jpg")));
  await contextMenu(page).getByRole("menuitem", { name: "Add to input" }).click();
  const ref = referenceTray(page).getByRole("button", { name: /landscape-alps\.jpg/ }).first();
  await rightClick(ref);
  expect(await menuTitle(page)).toBe("landscape-alps.jpg");
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["View", "Download", "Remove reference image"]));
});

test("move to bin asks first; cancel changes nothing", async ({ page }) => {
  const before = await page.request.get("/api/images?limit=1").then((r) => r.json());
  await rightClick((await shownLibTile(page, "landscape-alps.jpg")));
  await contextMenu(page).getByRole("menuitem", { name: "Move to bin" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect((await shownLibTile(page, "landscape-alps.jpg"))).toBeVisible();
  const after = await page.request.get("/api/images?limit=1").then((r) => r.json());
  expect(after.total).toBe(before.total);
  await expect(page.getByRole("button", { name: "Recycle bin (1)" })).toBeVisible();
});

test("confirm dialog opened from the viewer sits above it; Esc closes only the dialog", async ({ page }) => {
  await openViewerOn(page, "landscape-alps.jpg");
  const v = viewer(page);
  await rightClick(v.getByRole("img", { name: "landscape-alps.jpg" }));
  await contextMenu(page).getByRole("menuitem", { name: "Move to bin" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // The dialog is the topmost element at its own centre.
  const onTop = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(onTop).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(v).toBeVisible();
  await expect(v.getByRole("heading", { level: 2 })).toHaveText("landscape-alps.jpg");
});

test("text fields keep the system context menu", async ({ page }) => {
  const read = await watchContextMenuDefault(page);
  await page.getByRole("textbox", { name: "Prompt" }).click({ button: "right" });
  await page.getByRole("textbox", { name: /Search filename/ }).click({ button: "right" });
  expect(await read()).toEqual([false, false]);
  await expect(contextMenu(page)).toHaveCount(0);
});

test("a touch contextmenu does not open the menu", async ({ page }) => {
  const tile = (await shownLibTile(page, "landscape-alps.jpg"));
  await tile.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        clientX: r.left + 10,
        clientY: r.top + 10,
      }),
    );
  });
  await page.waitForTimeout(300);
  await expect(contextMenu(page)).toHaveCount(0);
});

test("menu near the bottom-right corner flips up-left and keeps 8px from the edges", async ({ page }) => {
  const size = page.viewportSize()!;
  // No thumbnail sits in the corner, so send a tile's contextmenu event with
  // corner coordinates: the menu opens at the event's clientX/clientY.
  const tile = (await shownLibTile(page, "landscape-alps.jpg"));
  await tile.evaluate(
    (el, { w, h }) => {
      el.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: w - 3, clientY: h - 3 }),
      );
    },
    { w: size.width, h: size.height },
  );
  const panel = contextMenu(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("visibility", "visible");
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(size.width - 8 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height - 8 + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(8 - 0.5);
  expect(box.y).toBeGreaterThanOrEqual(8 - 0.5);
  // Flipped: the panel ends left of / above the click point.
  expect(box.x + box.width).toBeLessThan(size.width - 3);
  expect(box.y + box.height).toBeLessThan(size.height - 3);

  // The tag submenu also stays inside the window.
  await panel.getByRole("menuitem", { name: "Tags" }).hover();
  const sub = submenu(page);
  await expect(sub).toBeVisible();
  await expect(sub).toHaveCSS("visibility", "visible");
  const sb = (await sub.boundingBox())!;
  expect(sb.x).toBeGreaterThanOrEqual(8 - 0.5);
  expect(sb.y + sb.height).toBeLessThanOrEqual(size.height - 8 + 0.5);
  expect(sb.x + sb.width).toBeLessThanOrEqual(size.width - 8 + 0.5);
});
