import { contextMenu, expect, openApp, rightClick, submenu, test } from "../fixtures";
import { libTile } from "../ui";

// Screenshots for a human glance; attached to the report, never compared.
test.use({ colorScheme: "dark" });

test("dark mode: menu and tag submenu (attachment only)", async ({ page }, testInfo) => {
  await openApp(page);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  await rightClick(libTile(page, "product-mug.webp"));
  await expect(contextMenu(page)).toHaveCSS("visibility", "visible");
  await contextMenu(page).getByRole("menuitem", { name: "Tags" }).hover();
  await expect(submenu(page)).toHaveCSS("visibility", "visible");
  await testInfo.attach("dark-context-menu.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
