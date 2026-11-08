import type { Locator, Page } from "@playwright/test";
import { contextMenu, expect, test } from "../fixtures";
import { expectNoHorizontalScroll, libTile, shownLibTile } from "../ui";

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

interface TouchCdp {
  send(method: string, params?: unknown): Promise<unknown>;
  detach(): Promise<void>;
}

async function touchDown(page: Page, x: number, y: number): Promise<TouchCdp> {
  const cdp = (await page.context().newCDPSession(page)) as TouchCdp;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  return cdp;
}

async function touchMove(cdp: TouchCdp, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y }],
  });
}

async function touchUp(cdp: TouchCdp) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await expect((await shownLibTile(page, "landscape-alps.jpg"))).toBeVisible();
});

test("long-press a thumbnail enters multi-select", async ({ page }) => {
  await longPress(page, (await shownLibTile(page, "landscape-alps.jpg")));
  const selected = page.locator(".library-grid .lib-tile.selected");
  await expect(selected).toHaveCount(1);
  await expect(page.locator(".library-grid .lib-tile.selecting").first()).toBeVisible();
  // No viewer and no custom context menu from the long-press.
  await expect(page.locator(".viewer-overlay")).toHaveCount(0);
  await expect(contextMenu(page)).toHaveCount(0);
  // A second tap extends the selection.
  await tap(page, (await shownLibTile(page, "landscape-dunes.jpg")));
  await expect(selected).toHaveCount(2);
});

test("tap opens the viewer; no hover preview is left behind", async ({ page }) => {
  await tap(page, (await shownLibTile(page, "landscape-alps.jpg")));
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

test("phone scrubber expands into a capsule and local ruler only while dragging", async ({ page }) => {
  const scrollbar = page.getByRole("scrollbar", { name: "Browse position" });
  const thumb = page.locator(".lib-scrubber.phone .lib-scrubber-thumb");
  const ruler = page.locator(".lib-scrubber.phone .lib-phone-ruler");
  await expect(scrollbar).toBeVisible();
  await expect(page.locator(".lib-scrubber.phone .lib-scrubber-track")).toBeHidden();
  await expect(thumb).not.toHaveClass(/expanded/);

  const idle = (await thumb.boundingBox())!;
  expect(idle.width).toBeLessThan(8);
  const x = idle.x + idle.width / 2;
  const y = idle.y + idle.height / 2;
  const cdp = await touchDown(page, x, y);
  try {
    await page.waitForTimeout(80);
    await expect(thumb).not.toHaveClass(/expanded/);
    await touchMove(cdp, x, y + 24);
    await expect(thumb).toHaveClass(/expanded/);
    await expect(ruler).toHaveClass(/\bon\b/);
    await expect(page.locator(".lib-scrubber.phone .lib-phone-count")).toHaveText(/#\d+ of \d+/);
    await expect(scrollbar).toHaveAttribute("aria-valuetext", /#\d+ of \d+/);
    const currentTick = page.locator(".lib-phone-ruler-tick.current");
    await expect(currentTick).toHaveCount(1);
    await expect(currentTick).toHaveCSS("background-color", "rgb(79, 70, 229)");
    await expect(thumb).toHaveCSS("background-color", "rgba(255, 255, 255, 0.86)");
    await expect(page.locator(".lib-phone-grip")).toHaveCSS("background-color", "rgb(79, 70, 229)");

    const gutter = await page.evaluate(() => {
      const grid = document.querySelector(".library-vgrid")!.getBoundingClientRect();
      const card = document.querySelector(".phone-island")!.getBoundingClientRect();
      return [...document.querySelectorAll(".lib-phone-ruler-tick")].every((tick) => {
        const box = tick.getBoundingClientRect();
        return box.left >= grid.right - 0.5 && box.right <= card.right;
      });
    });
    expect(gutter).toBe(true);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(thumb).toHaveCSS("background-color", "rgba(30, 41, 59, 0.78)");
    await expect(page.locator(".lib-phone-grip")).toHaveCSS("background-color", "rgb(129, 140, 248)");
    await expect(currentTick).toHaveCSS("background-color", "rgb(165, 180, 252)");
    await expect(page.locator(".lib-phone-ruler-label").first()).toHaveCSS(
      "background-color",
      "rgb(30, 41, 59)",
    );

    await expect(thumb).toHaveCSS("width", "180px");
    const capsule = (await thumb.boundingBox())!;
    await touchMove(cdp, x, y + 30);
    const next = (await thumb.boundingBox())!;
    expect(capsule.width).toBeGreaterThan(174);
    expect(Math.abs(next.width - capsule.width)).toBeLessThan(0.5);
  } finally {
    await touchUp(cdp);
  }

  await expect(ruler).not.toHaveClass(/\bon\b/);
  await expect(thumb).toHaveClass(/expanded/);
  await page.waitForTimeout(850);
  await expect(thumb).not.toHaveClass(/expanded/);

  const scrubber = page.locator(".lib-scrubber.phone");
  await expect(scrubber).toHaveClass(/faded/, { timeout: 2600 });
  const scrolled = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>(".phone-island-scroll")].find(
      (el) => el.scrollHeight > el.clientHeight + 20,
    );
    if (!scroller) return false;
    scroller.scrollTop += 80;
    return true;
  });
  expect(scrolled).toBe(true);
  await expect(scrubber).not.toHaveClass(/faded/);
});

test("long-pressing the phone scrubber opens Jump without a capsule flash", async ({ page }) => {
  await page.locator(".lib-scrubber.phone .lib-scrubber-thumb").evaluate((thumb) => {
    (window as unknown as { __capsuleFlashes: number }).__capsuleFlashes = 0;
    new MutationObserver(() => {
      if (thumb.classList.contains("expanded")) {
        (window as unknown as { __capsuleFlashes: number }).__capsuleFlashes += 1;
      }
    }).observe(thumb, { attributes: true, attributeFilter: ["class"] });
  });

  const scrollbar = page.getByRole("scrollbar", { name: "Browse position" });
  const box = (await scrollbar.boundingBox())!;
  const cdp = await touchDown(page, box.x + box.width / 2, box.y + box.height / 2);
  try {
    await page.waitForTimeout(520);
    await expect(page.locator(".lib-scrubber.phone .lib-scrubber-thumb")).not.toHaveClass(/expanded/);
    await expect(page.locator(".lib-phone-ruler.on")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __capsuleFlashes?: number }).__capsuleFlashes ?? 0,
      ),
    ).toBe(0);
  } finally {
    await touchUp(cdp);
  }
  await expect(page.getByRole("dialog", { name: "Jump to" })).toBeVisible();
  await expect(page.locator(".lib-scrubber.phone .lib-scrubber-thumb")).not.toHaveClass(/expanded/);
});

/** Month cells wholly inside the strip viewport. */
async function visibleMonths(page: Page) {
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

test("tapping the position line opens a headless jump drawer with 7 whole months", async ({ page }) => {
  await page.locator(".lib-position").tap();
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await expect(dialog).toBeVisible();
  // No title row and no ✕; the sheet's aria-label still names the dialog.
  await expect(page.locator(".jump-sheet .sheet-head")).toHaveCount(0);
  await expect(page.locator(".jump-sheet").getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(page.locator(".jump-search-box input")).toHaveCSS("font-size", "16px");
  await expect(page.locator(".jump-strip")).toHaveCSS("scrollbar-width", "none");
  await expect.poll(() => visibleMonths(page)).toBe(7);
  // The leftmost month pins its year at the left edge of the strip.
  await expect(page.locator(".jump-strip-year-pin")).toHaveText("2026");

  await page.getByRole("button", { name: "Cancel" }).tap();
  await expect(dialog).toHaveCount(0);
});

test("dragging the drawer handle down closes the jump drawer", async ({ page }) => {
  await page.locator(".lib-position").tap();
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await expect(dialog).toBeVisible();
  const grab = page.locator(".jump-sheet .sheet-grab");
  const { x, y } = await touchPoint(grab);
  const cdp = await touchDown(page, x, y);
  try {
    for (const dy of [30, 70, 120]) {
      await touchMove(cdp, x, y + dy);
      await page.waitForTimeout(40);
    }
  } finally {
    await touchUp(cdp);
  }
  await expect(dialog).toHaveCount(0);
});

test("tapping a day in the drawer jumps and closes it", async ({ page }) => {
  const before = await page.locator(".lib-position-range").innerText();
  await page.locator(".lib-position").tap();
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await expect(dialog).toBeVisible();
  const current = page.locator(".jump-day.on");
  await expect(current).toHaveCount(1);
  await tap(page, current);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).toHaveText(before);
});

test("typing turns the drawer into a results list and its go key jumps", async ({ page }) => {
  const res = await page.request.get("/api/images?limit=1");
  const { total } = await res.json();
  expect(total).toBeGreaterThan(10);

  await page.locator(".lib-position").tap();
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await expect(dialog).toBeVisible();
  const input = page.locator(".jump-search-box input");
  await input.tap();
  await input.fill("#10");

  await expect(page.locator(".jump-strip")).toHaveCount(0);
  await expect(page.locator(".jump-calendar")).toHaveCount(0);
  await expect(page.locator(".jump-result")).toHaveCount(1);
  await expect(page.locator(".jump-result")).toContainText("#10");
  await expect(page.locator(".jump-sheet")).toHaveClass(/jump-sheet-typing/);
  await expect(page.locator(".jump-result")).toHaveCSS("height", "52px");
  const sheet = (await page.locator(".jump-sheet").boundingBox())!;
  expect(sheet.y).toBeLessThanOrEqual(60);

  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".lib-position-range")).toContainText("9–");
});

test("swiping the phone month strip snaps to whole months", async ({ page }) => {
  await page.locator(".lib-position").tap();
  const strip = page.locator(".jump-strip");
  await expect(strip).toBeVisible();
  await page.waitForTimeout(500);
  const box = (await strip.boundingBox())!;
  const cellW = box.width / 7;
  const before = await strip.evaluate((el) => el.scrollLeft);
  expect(before).toBeGreaterThan(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    xDistance: 200,
    yDistance: 0,
    gestureSourceType: "touch",
    speed: 800,
  });
  await page.waitForTimeout(900);
  const after = await strip.evaluate((el) => el.scrollLeft);
  expect(after).toBeLessThan(before);
  expect(Math.abs(after - Math.round(after / cellW) * cellW)).toBeLessThan(1.5);
  await expect.poll(() => visibleMonths(page)).toBe(7);
});
