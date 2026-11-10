import { contextMenu, expect, menuLabels, menuTitle, openApp, rightClick, submenu, test } from "../fixtures";
import { shownLibTile } from "../ui";

// Changes tags: every test starts from a fresh library copy.
test.use({ freshLibrary: true });

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

async function imageByName(page: import("@playwright/test").Page, name: string) {
  const body = await (await page.request.get(`/api/images?limit=200&q=${encodeURIComponent(name)}`)).json();
  const img = body.images.find((i: { filename: string }) => i.filename === name);
  expect(img, `image ${name}`).toBeTruthy();
  return img as { id: number; tags: { id: number; name: string }[] };
}

test("right-clicking an unselected image in select mode adds it, then opens the batch menu; Esc keeps the selection", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await (await shownLibTile(page, "landscape-alps.jpg")).click();
  await (await shownLibTile(page, "landscape-dunes.jpg")).click();
  const selected = page.locator(".library-grid .lib-tile.selected");
  await expect(selected).toHaveCount(2);

  await rightClick((await shownLibTile(page, "texture-terrazzo.png")));
  await expect(contextMenu(page)).toBeVisible();
  expect(await menuTitle(page)).toBe("3 selected");
  expect(await menuLabels(page)).toEqual(
    expect.arrayContaining(["Download", "Add tag", "Remove tag", "Move to Bin"]),
  );
  await expect(selected).toHaveCount(3);

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
  await expect(selected).toHaveCount(3);
});

test("new tag from the tag submenu lands on the image", async ({ page }) => {
  await rightClick((await shownLibTile(page, "landscape-alps.jpg")));
  await contextMenu(page).getByRole("menuitem", { name: "Tags" }).click();
  const sub = submenu(page);
  await expect(sub).toBeVisible();
  await sub.getByRole("menuitem", { name: "New tag…" }).click();
  await sub.getByRole("textbox", { name: "New tag…" }).fill("e2e-alpine");
  await page.keyboard.press("Enter");
  await expect(contextMenu(page)).toHaveCount(0);

  await expect
    .poll(async () => (await imageByName(page, "landscape-alps.jpg")).tags.map((t) => t.name))
    .toContain("e2e-alpine");
  // The library chip row shows the new tag too.
  await expect(page.getByRole("button", { name: /^e2e-alpine/ }).first()).toBeVisible();
});

test("clicking the active tag clears the filter, expanded or collapsed", async ({ page }) => {
  const row = page.locator(".tag-filter-row");
  const chip = row.locator(".tag-chip").filter({ hasText: /^产品/ }).first();

  await chip.click();
  await expect(chip).toHaveClass(/\bon\b/);
  await chip.click();
  await expect(chip).not.toHaveClass(/\bon\b/);
  await expect(row.locator(".tag-chip.on")).toHaveText("All");

  await chip.click();
  await page.getByRole("button", { name: "Hide tags" }).click();
  await expect(row.getByText(/tags hidden/)).toBeVisible();
  await expect(chip).toHaveClass(/\bon\b/);
  await chip.click();
  await expect(row.locator(".tag-chip.on")).toHaveText("All");
});

test("batch remove-tag lists only tags the selected images carry", async ({ page }) => {
  // The long-named upload has no tags; product-mug.webp carries only 产品.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await (await shownLibTile(page, /^a-very-long-filename/)).click();
  await (await shownLibTile(page, "product-mug.webp")).click();
  await rightClick((await shownLibTile(page, "product-mug.webp")));
  expect(await menuTitle(page)).toBe("2 selected");
  await contextMenu(page).getByRole("menuitem", { name: "Remove tag" }).click();
  const options = submenu(page).getByRole("menuitemcheckbox");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("产品");

  // Removing it from the batch clears it from the image.
  await options.first().click();
  await expect
    .poll(async () => (await imageByName(page, "product-mug.webp")).tags.map((t) => t.name))
    .not.toContain("产品");
});
