import { expect, test, openApp } from "../fixtures";

// The jump palette (N2) over a timeline that spans three years. The template
// library only contains today's images, so this file supplies a deterministic
// multi-year /api/images/timeline answer; every index stays inside the real
// library total so jumps scroll the real virtual grid.

const MOCK_DAYS: [number, string][] = [
  [0, "2024-01-10"],
  [1, "2024-01-11"],
  [2, "2024-06-05"],
  [3, "2025-01-15"],
  [4, "2025-06-10"],
  [5, "2025-12-20"],
  [6, "2026-01-05"],
  [7, "2026-03-14"],
  [8, "2026-06-15"],
  [9, "2026-11-08"],
];

async function openWithTimeline(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/images?limit=1");
  const { total } = await response.json();
  const picks = MOCK_DAYS.filter(([index]) => index < total);
  const days = picks.map(([index, day]) => ({ day, count: 1, first_index: index }));
  const runs = picks.map(([index, day]) => [index, day]);
  await page.route("**/api/images/timeline*", (route) =>
    route.fulfill({ json: { days, runs, total } }),
  );
  await openApp(page);
  return total;
}

/** Month cells that are wholly inside the strip viewport. */
async function wholeMonths(page: import("@playwright/test").Page) {
  const strip = page.locator(".jump-strip");
  const box = (await strip.boundingBox())!;
  return strip.locator(".jump-strip-month").evaluateAll(
    (els, viewport) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= viewport.x - 0.5 && r.right <= viewport.x + viewport.width + 0.5;
      }).length,
    box,
  );
}

test("position line opens the palette; clicking a day jumps and closes", async ({ page }) => {
  const total = await openWithTimeline(page);
  await expect(page.locator(".lib-position-month")).toHaveText("Jan 2024");
  const initialRange = await page.locator(".lib-position-range").innerText();

  await page.locator(".lib-position").click();
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".jump-search input")).toBeFocused();
  await expect(page.locator(".jump-popover")).toHaveCount(1);

  // No footer Go button, no year picker / month cards, no scrollbar.
  await expect(page.getByRole("button", { name: "Go", exact: true })).toHaveCount(0);
  await expect(page.locator(".jump-strip")).toHaveCSS("scrollbar-width", "none");
  await expect.poll(() => wholeMonths(page)).toBe(12);
  await expect(page.locator(".jump-strip-year")).toHaveText(["2024", "2025", "2026"]);

  await page.getByRole("option", { name: "June 2025 · 1" }).click();
  await expect(page.locator(".jump-calendar-head b")).toHaveText("June 2025");
  await page.getByRole("gridcell", { name: /^Jun 10, 2025/ }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).not.toHaveText(initialRange);
  await expect(page.locator(".lib-position")).toHaveAttribute("aria-expanded", "false");
  // The clicked row is now at / near the top of the real grid.
  expect(total).toBeGreaterThan(3);
});

test("typing lists every interpretation and Enter jumps to the first one", async ({ page }) => {
  const total = await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const input = page.locator(".jump-search input");
  await input.fill("2025");

  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("2025");
  await expect(rows.nth(0)).toContainText(/images · from #\d/);
  await expect(rows.nth(1)).toContainText(`#${total}`);
  await expect(rows.nth(1)).toContainText("Image number");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".jump-strip")).toHaveCount(0);
  await expect(page.locator(".jump-calendar")).toHaveCount(0);

  // Clearing the query restores the strip and the calendar, re-measured.
  await input.fill("");
  await expect(page.locator(".jump-calendar")).toHaveCount(1);
  await expect.poll(() => wholeMonths(page)).toBe(12);
  await input.fill("2025");
  await expect(rows).toHaveCount(2);

  // ↑ / ↓ move the highlight; Enter jumps to the highlighted row and closes.
  await input.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(page.locator(".jump-popover")).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).not.toHaveText(/^1–/);
});

test("typing a jump index and pressing Enter jumps there", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const input = page.locator(".jump-search input");
  await input.fill("#10");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("#10");
  await input.press("Enter");
  await expect(page.locator(".jump-popover")).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).toContainText("9–");
});

test("the strip snaps to whole months and pins the leftmost year", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");
  const stripBox = (await strip.boundingBox())!;
  const cellW = stripBox.width / 12;
  await expect(page.getByRole("button", { name: "Previous year" })).toBeDisabled();

  // Wheel / trackpad scroll then snap: the resting offset is a whole cell.
  await strip.hover();
  await page.mouse.wheel(0, Math.round(cellW * 2.6));
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(cellW);
  await page.waitForTimeout(500);
  const resting = await strip.evaluate((el) => el.scrollLeft);
  expect(Math.abs(resting - Math.round(resting / cellW) * cellW)).toBeLessThan(1.5);
  await expect.poll(() => wholeMonths(page)).toBe(12);

  // Land on December 2024 (not January): the pinned label must say 2024.
  await strip.evaluate((el, left) => {
    el.scrollLeft = left;
  }, 11 * cellW);
  await page.waitForTimeout(350);
  await expect(page.locator(".jump-strip-year-pin")).toHaveText("2024");

  // Cross into February 2025: the pinned label follows the leftmost month.
  await strip.evaluate((el, left) => {
    el.scrollLeft = left;
  }, 13 * cellW);
  await page.waitForTimeout(350);
  await expect(page.locator(".jump-strip-year-pin")).toHaveText("2025");

  // ‹ / › move a year; the button at the end is disabled.
  const prev = page.getByRole("button", { name: "Previous year" });
  const next = page.getByRole("button", { name: "Next year" });
  await expect(prev).toBeEnabled();
  const beforeNext = await strip.evaluate((el) => el.scrollLeft);
  await next.click();
  await page.waitForTimeout(700);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(beforeNext);
  await strip.evaluate((el, left) => {
    el.scrollLeft = left;
  }, 24 * cellW);
  await page.waitForTimeout(300);
  await expect(next).toBeDisabled();
});

/** Wait until native scrolling / snapping has come to rest. */
async function stripRest(page: import("@playwright/test").Page) {
  const strip = page.locator(".jump-strip");
  let previous = await strip.evaluate((el) => el.scrollLeft);
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(120);
    const current = await strip.evaluate((el) => el.scrollLeft);
    stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) return current;
  }
  return previous;
}

async function expectLeftmostYear(page: import("@playwright/test").Page) {
  const strip = page.locator(".jump-strip");
  const box = (await strip.boundingBox())!;
  const cellW = box.width / 12;
  const left = await strip.evaluate((el) => el.scrollLeft);
  const index = Math.round(left / cellW);
  const cell = strip.locator(".jump-strip-month").nth(index);
  const label = (await cell.getAttribute("aria-label"))!;
  const year = label.match(/\d{4}/)![0];
  const pin = page.locator(".jump-strip-year-pin");
  if (await pin.count()) await expect(pin).toHaveText(year);
  else await expect(cell.locator(".jump-strip-year")).toHaveText(year);
}

test("a sideways trackpad wheel scrolls natively and snaps to a whole month", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");
  const box = (await strip.boundingBox())!;
  const cellW = box.width / 12;

  await strip.hover();
  await page.mouse.wheel(300, 0);
  const resting = await stripRest(page);
  expect(resting).toBeGreaterThan(cellW);
  expect(Math.abs(resting - Math.round(resting / cellW) * cellW)).toBeLessThan(1.5);
  await expectLeftmostYear(page);
});

test("a vertical mouse wheel moves the strip sideways and snaps", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");
  const box = (await strip.boundingBox())!;
  const cellW = box.width / 12;

  await strip.hover();
  await page.mouse.wheel(0, 240);
  const resting = await stripRest(page);
  expect(resting).toBeGreaterThan(2 * cellW);
  expect(Math.abs(resting - Math.round(resting / cellW) * cellW)).toBeLessThan(1.5);
  await expectLeftmostYear(page);
});

test("small sideways trackpad deltas cross more than two months", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");
  const box = (await strip.boundingBox())!;
  const cellW = box.width / 12;

  await strip.hover();
  for (let i = 0; i < 20; i++) {
    // A real trackpad sends many small deltaX events with a little deltaY.
    await page.mouse.wheel(8, i % 2 ? 0.5 : -0.5);
    await page.waitForTimeout(12);
  }
  const resting = await stripRest(page);
  expect(resting).toBeGreaterThan(2 * cellW);
  expect(Math.abs(resting - Math.round(resting / cellW) * cellW)).toBeLessThan(1.5);
  await expectLeftmostYear(page);
});

test("dragging the strip scrolls without selecting a month", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");
  const heading = page.locator(".jump-calendar-head b");
  await expect(heading).toHaveText("January 2024");
  const box = (await strip.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 160, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);

  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expect(heading).toHaveText("January 2024");
});

test("Tab reaches the strip and the calendar; arrows and Enter navigate", async ({ page }) => {
  await openWithTimeline(page);
  await page.locator(".lib-position").click();
  const strip = page.locator(".jump-strip");

  for (let i = 0; i < 12; i++) {
    if (await page.evaluate(() => document.activeElement?.classList.contains("jump-strip"))) break;
    await page.keyboard.press("Tab");
  }
  await expect(strip).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

  await page.keyboard.press("Tab");
  const days = page.locator(".jump-days");
  await expect(days).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(days).toHaveAttribute("aria-activedescendant", "jump-day-2024-01-11");
  await page.keyboard.press("Enter");
  await expect(page.locator(".jump-popover")).toHaveCount(0);
});

test("Back to top is hidden at the top, appears after scrolling, and returns", async ({ page }) => {
  await openApp(page);
  const backToTop = page.getByRole("button", { name: "Back to top" });
  await expect(backToTop).toHaveCount(0);
  const firstRange = await page.locator(".lib-position-range").innerText();

  const scrolled = await page.locator(".library-vgrid").first().evaluate((el) => {
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    (scroller ?? document.scrollingElement!).scrollTop += 1200;
    return (scroller ?? document.scrollingElement!).scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await expect(backToTop).toBeVisible();
  await expect(backToTop).toHaveAttribute("aria-label", "Back to top");
  await expect(page.locator(".lib-position-range")).not.toHaveText(firstRange);

  await backToTop.click();
  await expect(backToTop).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).toHaveText(firstRange);
});
