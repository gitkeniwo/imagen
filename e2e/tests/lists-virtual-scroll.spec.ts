import type { Page, Route } from "@playwright/test";
import { expect, openApp, sidebarTab, test } from "../fixtures";

type Rec = Record<string, any>;

const GENERATION_COUNT = 3000;
const DRAFT_COUNT = 600;
const DRAFT_PINNED = 12;
const DAY_MS = 86_400_000;
const NEWEST = Date.UTC(2026, 10, 8, 12);

function createdFor(index: number, perDay = 4): string {
  return new Date(NEWEST - Math.floor(index / perDay) * DAY_MS).toISOString();
}

function generationRecords(image: Rec): Rec[] {
  return Array.from({ length: GENERATION_COUNT }, (_, index) => {
    const status = index % 19 === 0 ? "error" : index % 23 === 0 ? "blocked" : "success";
    const output = status === "error" ? null : { ...image };
    return {
      id: 100_000 + index,
      prompt:
        index % 13 === 0
          ? `Long history prompt ${index}: ` + "porcelain lighthouse at dawn ".repeat(18)
          : index % 17 === 0
            ? `Sneaker on dunes at golden hour · ${index}`
            : `History record ${index + 1}`,
      provider: index % 4 === 0 ? "gemini" : "vertex",
      model: index % 5 === 0 ? "gemini-2.5-flash-image" : "gemini-3-pro-image",
      aspect_ratio: ["1:1", "16:9", "3:4"][index % 3],
      resolution: "2K",
      status,
      error_message: status === "error" ? "Synthetic upstream error" : null,
      raw_finish: status === "blocked" ? "IMAGE_SAFETY" : null,
      output_image_id: output?.id ?? null,
      created_at: createdFor(index),
      source: index % 9 === 0 ? "manual" : "vertex",
      client_task_id: null,
      marker_color: null,
      duration_ms: 1200 + index,
      attempts: 1,
      series_id: null,
      inputs: index % 3 === 0 ? [{ ...image }] : [],
      outputImage: output,
      generation_offset: index,
      output_index: index,
    };
  });
}

function draftRecords(image: Rec): Rec[] {
  return Array.from({ length: DRAFT_COUNT }, (_, index) => {
    const pinned = index < DRAFT_PINNED;
    const updated = pinned
      ? new Date(NEWEST - index * DAY_MS).toISOString()
      : new Date(NEWEST - (index - DRAFT_PINNED + 1) * DAY_MS).toISOString();
    return {
      id: 200_000 + index,
      prompt:
        index % 11 === 0
          ? `Long draft prompt ${index}: ` + "linen folds and soft window light ".repeat(18)
          : `Draft record ${index + 1}`,
      provider: index % 4 === 0 ? "gemini" : "vertex",
      model: index % 6 === 0 ? "gemini-2.5-flash-image" : "gemini-3-pro-image",
      aspect_ratio: ["1:1", "16:9", "3:4"][index % 3],
      resolution: "2K",
      output_format: "image/jpeg",
      skip_if_preceding_succeeds: 0,
      pinned: pinned ? 1 : 0,
      legacy_generation_id: null,
      created_at: updated,
      updated_at: updated,
      inputImages: index % 2 === 0 ? [{ ...image }] : [],
      outputImages: index % 3 === 0 ? [{ ...image }] : [],
      tags: index % 7 === 0 ? [{ id: 1, name: "synthetic", color: null }] : [],
      series_id: null,
    };
  });
}

function timelineFor(records: Rec[], dateKey: string, pinned = 0) {
  const days = new Map<string, { day: string; count: number; first_index: number }>();
  const runs: [number, string][] = [];
  let previous: string | null = null;
  records.forEach((record, offset) => {
    const index = pinned + offset;
    const day = record[dateKey].slice(0, 10);
    const current = days.get(day);
    if (current) current.count += 1;
    else days.set(day, { day, count: 1, first_index: index });
    if (day !== previous) runs.push([index, day]);
    previous = day;
  });
  return {
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    runs,
    total: records.length + pinned,
    ...(pinned ? { pinned } : {}),
  };
}

function filteredGenerations(records: Rec[], params: URLSearchParams): Rec[] {
  const query = (params.get("q") || "").trim().toLowerCase();
  const status = params.get("status");
  const kind = params.get("kind");
  return records.filter((record) => {
    if (query && !String(record.prompt).toLowerCase().includes(query)) return false;
    if (params.get("starred") === "true" && !record.outputImage?.starred) return false;
    if (params.get("with_output") === "true" && !record.outputImage) return false;
    if (status === "error" && !["error", "aborted"].includes(record.status)) return false;
    if (status === "success" && record.status !== "success") return false;
    if (status === "blocked" && record.status !== "blocked") return false;
    if (kind && record.source !== kind) return false;
    return true;
  });
}

async function pageForList(
  route: Route,
  records: Rec[],
  kind: "generations" | "drafts",
) {
  const url = new URL(route.request().url());
  const params = url.searchParams;
  if (kind === "generations") {
    if (url.pathname === "/api/generations/timeline") {
      const filtered = filteredGenerations(records, params);
      await route.fulfill({ json: timelineFor(filtered, "created_at") });
      return;
    }
    if (url.pathname === "/api/generations/ids") {
      const filtered = filteredGenerations(records, params);
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 5000);
      await route.fulfill({
        json: {
          ids: filtered.slice(offset, offset + limit).map((row) => row.id),
          total: filtered.length,
        },
      });
      return;
    }
    if (url.pathname === "/api/generations") {
      const filtered = filteredGenerations(records, params);
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 40);
      const rows = filtered.slice(offset, offset + limit).map((row, index) => ({
        ...row,
        generation_offset: offset + index,
        output_index: offset + index,
      }));
      await route.fulfill({
        json: {
          generations: rows,
          total: filtered.length,
          output_total: filtered.filter((row) => row.outputImage).length,
          output_offset: offset,
        },
      });
      return;
    }
  } else {
    const query = (params.get("q") || "").trim().toLowerCase();
    const filtered = records.filter(
      (row) => !query || String(row.prompt).toLowerCase().includes(query),
    );
    if (url.pathname === "/api/drafts/timeline") {
      const pinned = filtered.findIndex((row) => !row.pinned);
      const count = pinned < 0 ? filtered.length : pinned;
      await route.fulfill({
        json: timelineFor(filtered.slice(count), "updated_at", count),
      });
      return;
    }
    if (url.pathname === "/api/drafts") {
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 40);
      await route.fulfill({
        json: {
          drafts: filtered.slice(offset, offset + limit),
          total: filtered.length,
        },
      });
      return;
    }
  }
  await route.fallback();
}

async function mockGenerations(page: Page, records: Rec[]) {
  await page.route("**/api/generations**", (route) =>
    pageForList(route, records, "generations"),
  );
}

async function mockDrafts(page: Page, records: Rec[]) {
  await page.route("**/api/drafts**", (route) =>
    pageForList(route, records, "drafts"),
  );
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nK0AAAAASUVORK5CYII=",
  "base64",
);

function uniqueOutputImages(records: Rec[], image: Rec): Rec[] {
  return records.map((record, index) => {
    const output = {
      ...image,
      id: 700_000 + index,
      sha256: String(index + 1).padStart(64, "0"),
      filename: `mock-output-${index}.png`,
      note: record.outputImage?.note ?? null,
    };
    return {
      ...record,
      output_image_id: output.id,
      outputImage: record.outputImage ? output : null,
      inputs: (record.inputs ?? []).map(() => ({ ...output })),
    };
  });
}

async function mockGeneratedImages(page: Page, records: Rec[]) {
  await page.route("**/api/images/*/thumb**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_PIXEL_PNG,
    }),
  );
  await page.route("**/api/images/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const id = Number(url.pathname.split("/").pop());
    const body = request.postDataJSON() as {
      starred?: boolean;
      note?: string;
    };
    let updated: Rec | null = null;
    for (const record of records) {
      const output = record.outputImage;
      if (output?.id !== id) continue;
      if (body.starred !== undefined) output.starred = body.starred ? 1 : 0;
      if (body.note !== undefined) output.note = body.note;
      record.outputImage = output;
      updated = output;
    }
    await route.fulfill({ json: updated ?? {} });
  });
}

async function imageFixture(page: Page): Promise<Rec> {
  const response = await page.request.get("/api/images?limit=1");
  const body = await response.json();
  return { ...body.images[0], starred: 1 };
}

async function scrollList(page: Page, className: string, ratio: number) {
  return page.locator(`.${className}`).evaluate((element, fraction) => {
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller) {
      const overflow = getComputedStyle(scroller).overflowY;
      if (
        (overflow === "auto" || overflow === "scroll") &&
        scroller.scrollHeight > scroller.clientHeight
      ) {
        break;
      }
      scroller = scroller.parentElement;
    }
    const target = scroller ?? (document.scrollingElement as HTMLElement);
    target.scrollTop = (target.scrollHeight - target.clientHeight) * fraction;
    return target.scrollTop;
  }, ratio);
}

test("History virtualizes, jumps by #, and returns to the top", async ({ page }) => {
  const image = await imageFixture(page);
  await mockGenerations(page, generationRecords(image));
  await openApp(page);
  await sidebarTab(page, "History");

  await expect(page.locator(".history-vgrid .hcard").first()).toBeVisible();
  expect(await page.locator(".history-vgrid .hcard").count()).toBeLessThan(80);

  const scrolled = await scrollList(page, "history-vgrid", 0.55);
  expect(scrolled).toBeGreaterThan(1000);
  await expect(page.locator(".list-position-range")).not.toContainText("1–");
  expect(await page.locator(".history-vgrid .hcard").count()).toBeLessThan(80);

  await page.locator(".list-position").click();
  const input = page.locator(".jump-search input");
  await input.fill("#1200");
  await input.press("Enter");
  await expect(page.locator(".list-position-range")).toContainText("1,200–");

  await page.getByRole("button", { name: "Back to top" }).click();
  await expect(page.locator(".list-position-range")).toContainText("1–");
});

test("fixed History cards open the full prompt without changing height", async ({ page }) => {
  const image = await imageFixture(page);
  await mockGenerations(page, generationRecords(image));
  await openApp(page);
  await sidebarTab(page, "History");

  const cards = page.locator(".history-vgrid .hcard");
  await expect(cards.first()).toBeVisible();
  const heights = await cards.evaluateAll((nodes) =>
    nodes.slice(0, 4).map((node) => node.getBoundingClientRect().height),
  );
  expect(new Set(heights.map((height) => Math.round(height))).size).toBe(1);

  const article = page
    .getByRole("article")
    .filter({ hasText: "Long history prompt 0:" });
  const before = (await article.boundingBox())!.height;
  await article.getByRole("button", { name: "Full text" }).click();
  const dialog = page.getByRole("dialog", { name: "Prompt" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("porcelain lighthouse at dawn");
  expect((await article.boundingBox())!.height).toBe(before);
  await dialog.getByRole("button", { name: "Close" }).click();
});

test("History list headers stay aligned after jumping to a day", async ({ page }) => {
  const image = await imageFixture(page);
  const records = generationRecords(image);
  await mockGenerations(page, records);
  await openApp(page);
  await sidebarTab(page, "History");
  await page.getByRole("button", { name: "List" }).click();

  await page.locator(".list-position").click();
  const input = page.locator(".jump-search input");
  await input.fill("#449");
  await input.press("Enter");

  const day = records[448].created_at.slice(0, 10);
  const sameYear = Number(day.slice(0, 4)) === new Date().getFullYear();
  const label = new Intl.DateTimeFormat("en-US", {
    year: sameYear ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${day}T12:00:00`));
  const heading = page.locator(".history-vstack .hlist-day").filter({ hasText: label });
  await expect(heading).toBeVisible();
  const positions = await heading.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const toolbar = document.querySelector(".history-toolbar")!.getBoundingClientRect();
    return { top: rect.top, toolbarBottom: toolbar.bottom };
  });
  expect(positions.top).toBeGreaterThanOrEqual(positions.toolbarBottom - 1);
  expect(positions.top - positions.toolbarBottom).toBeLessThan(80);
});

test("History keeps its anchor and shows new rows after a refresh", async ({ page }) => {
  const image = await imageFixture(page);
  const records = generationRecords(image);
  await mockGenerations(page, records);
  await openApp(page);
  await sidebarTab(page, "History");
  await scrollList(page, "history-vgrid", 0.45);
  await page.waitForTimeout(150);
  await expect(page.locator(".list-position-range")).not.toContainText("1–");
  const before = (await page.locator(".list-position-range").innerText()).split(
    " of ",
  )[0];

  const extra = generationRecords(image)
    .slice(0, 3)
    .map((row, index) => ({
      ...row,
      id: 900_000 + index,
      prompt: `Fresh row ${index + 1}`,
      created_at: new Date(NEWEST + 60_000 * (index + 1)).toISOString(),
    }));
  records.unshift(...extra);
  const stars = page.locator(".history-vgrid .hcard-star");
  const visibleStar = await stars.evaluateAll((nodes) => {
    const scroller = document.querySelector(".side-scroll")!;
    const viewport = scroller.getBoundingClientRect();
    return nodes.findIndex((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    });
  });
  await stars.nth(visibleStar).click();

  await expect(page.locator(".lib-new-badge")).toContainText("3 new");
  const expectedStart =
    Number(before.split("–")[0].replaceAll(",", "")) + 3;
  await expect(page.locator(".list-position-range")).toContainText(
    `${expectedStart.toLocaleString("en-US")}–`,
  );
});

test("History selects every record matching the current filter", async ({ page }) => {
  const image = await imageFixture(page);
  await mockGenerations(page, generationRecords(image));
  await openApp(page);
  await sidebarTab(page, "History");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all results" }).click();
  await expect(page.locator(".batch-count")).toHaveText("3000 selected");
});

test("Favorites virtualizes and keeps the viewer/grid in sync", async ({ page }) => {
  const image = await imageFixture(page);
  const records = generationRecords(image);
  await mockGenerations(page, records);
  await openApp(page);
  await sidebarTab(page, "Favorites");

  await expect(page.locator(".history-vgrid .hcard").first()).toBeVisible();
  expect(await page.locator(".history-vgrid .hcard").count()).toBeLessThan(80);
  await scrollList(page, "history-vgrid", 0.4);
  const range = await page.locator(".list-position-range").innerText();

  await page.locator(".history-vgrid .hcard-media img").first().click();
  const viewer = page.locator(".viewer-overlay");
  await expect(viewer).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect(page.locator(".list-position-range")).not.toHaveText(range);
});

test("Favorites keeps an edited note and anchors after unfavoriting", async ({ page }) => {
  const baseImage = await imageFixture(page);
  const records = uniqueOutputImages(generationRecords(baseImage), baseImage);
  await mockGeneratedImages(page, records);
  await mockGenerations(page, records);
  await openApp(page);
  await sidebarTab(page, "Favorites");
  await scrollList(page, "history-vgrid", 0.35);
  await page.waitForTimeout(150);

  const visible = await page.locator(".history-vgrid article").evaluateAll((nodes) => {
    const scroller = document.querySelector(".side-scroll")!;
    const viewport = scroller.getBoundingClientRect();
    return nodes
      .map((node, index) => ({
        index,
        rect: node.getBoundingClientRect(),
      }))
      .filter(
        (item) =>
          item.rect.top < viewport.bottom &&
          item.rect.bottom > viewport.top,
      )
      .map((item) => item.index);
  });
  expect(visible.length).toBeGreaterThan(1);
  const articles = page.locator(".history-vgrid article");
  const note = articles.nth(visible[0]).locator(".fav-note");
  const totalBefore = Number(
    (await page.locator(".list-position-range").innerText())
      .split(" of ")[1]
      .replaceAll(",", ""),
  );
  await note.fill("Keep this note through refresh");
  await articles.nth(visible[1]).locator(".hcard-star").click();

  await expect(page.locator(".list-position-range")).toContainText(
    `of ${(totalBefore - 1).toLocaleString("en-US")}`,
  );
  await expect
    .poll(() =>
      page
        .locator(".history-vgrid .fav-note")
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLInputElement).value),
        ),
    )
    .toContain("Keep this note through refresh");
});

test("Drafts starts in Pinned, virtualizes, and jumps into the calendar", async ({ page }) => {
  const image = await imageFixture(page);
  await mockDrafts(page, draftRecords(image));
  await openApp(page);
  await sidebarTab(page, "Drafts");

  await expect(page.locator(".draft-list .gcard").first()).toBeVisible();
  await expect(page.locator(".list-position-month")).toHaveText("Pinned");
  await expect(page.locator(".list-position-range")).toContainText("1–");
  expect(await page.locator(".draft-list .gcard").count()).toBeLessThan(80);

  await page.locator(".list-position").click();
  await expect(
    page.getByRole("group", { name: "Jump to" }).getByRole("button", { name: /Pinned/ }),
  ).toBeVisible();
  const input = page.locator(".jump-search input");
  await input.fill("#301");
  await input.press("Enter");
  await expect(page.locator(".list-position-range")).toContainText("301–");
  expect(await page.locator(".draft-list .gcard").count()).toBeLessThan(80);
});

test("fixed Draft cards clamp long text and equalize heights", async ({ page }) => {
  const image = await imageFixture(page);
  await mockDrafts(page, draftRecords(image));
  await openApp(page);
  await sidebarTab(page, "Drafts");

  const cards = page.locator(".draft-list .gcard");
  await expect(cards.first()).toBeVisible();
  const heights = await cards.evaluateAll((nodes) =>
    nodes.slice(0, 4).map((node) => node.getBoundingClientRect().height),
  );
  expect(new Set(heights.map((height) => Math.round(height))).size).toBe(1);

  const long = page.getByRole("article").filter({ hasText: "Long draft prompt 0:" });
  const before = (await long.boundingBox())!.height;
  await long.getByRole("button", { name: "Full text" }).click();
  const dialog = page.getByRole("dialog", { name: "Prompt" });
  await expect(dialog).toContainText("linen folds and soft window light");
  expect((await long.boundingBox())!.height).toBe(before);
  await dialog.getByRole("button", { name: "Close" }).click();
});
