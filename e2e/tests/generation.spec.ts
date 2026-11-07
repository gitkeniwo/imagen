import { contextMenu, expect, menuLabels, openApp, rightClick, sidebarTab, test } from "../fixtures";
import { submitPrompt, queueCard } from "../queue";
import { sidebar } from "../ui";

// Runs generations against the fake backend (no provider is contacted).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("imagen-undo-send-seconds", "0"));
  await openApp(page);
});

test("[blocked] and [error] show their status in the queue; a success lands in library and history", async ({
  page,
}) => {
  const before = (await (await page.request.get("/api/images?limit=1")).json()).total as number;

  await submitPrompt(page, "e2e blocked run [blocked]");
  await submitPrompt(page, "e2e error run [error]");
  await submitPrompt(page, "e2e success run");

  const blocked = queueCard(page, "e2e blocked run [blocked]");
  const error = queueCard(page, "e2e error run [error]");
  const ok = queueCard(page, "e2e success run");
  await expect(blocked.locator(".hcard-status-label")).toHaveText("Blocked", { timeout: 20_000 });
  await expect(blocked).toContainText("IMAGE_SAFETY");
  await expect(error.locator(".hcard-status-label")).toHaveText("Error", { timeout: 20_000 });
  await expect(error).toContainText("403");
  await expect(ok.locator(".hcard-media img")).toBeVisible({ timeout: 20_000 });

  // The result is in the library (count + first tile) and in history.
  await expect
    .poll(async () => (await (await page.request.get("/api/images?limit=1")).json()).total)
    .toBe(before + 1);
  const newest = (await (await page.request.get("/api/images?limit=1")).json()).images[0];
  const name = await ok.locator(".hcard-media img").getAttribute("alt");
  await expect(page.locator(".library-grid .lib-tile > img").first()).toHaveAttribute("alt", name!);
  expect(newest.source).toBe("generated");

  await sidebarTab(page, "History");
  for (const prompt of ["e2e success run", "e2e blocked run [blocked]", "e2e error run [error]"]) {
    await expect(sidebar(page).getByRole("article").filter({ hasText: prompt })).toBeVisible();
  }

  // Queue result menu matches the task.
  await rightClick(ok.locator(".hcard-media img"));
  expect(await menuLabels(page)).toEqual(expect.arrayContaining(["View", "Download", "Copy prompt", "Reuse", "Rerun"]));
  await expect(contextMenu(page)).toContainText("e2e success run");
});
