import { expect, openApp, test } from "../fixtures";
import { libTile, shownLibTile, libTiles, openViewerOn, viewer, viewerTitle } from "../ui";

// Read-only.

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("used-in (reverse lineage): drill both ways, Esc walks back one level at a time", async ({ page }) => {
  await openViewerOn(page, "poster-alps-4k.png");
  const v = viewer(page);
  const info = v.getByRole("complementary", { name: "Image info" });
  const path = info.getByRole("navigation", { name: "Viewing path" });

  // Down into an input...
  await expect(info.getByRole("heading", { name: "Inputs · 2" })).toBeVisible();
  await info.getByRole("button", { name: /· Open this input in the viewer$/ }).first().click();
  await expect(path).toContainText("Input 1");
  const inputTitle = await viewerTitle(page).innerText();
  expect(inputTitle).toMatch(/^Generated · /);
  // ...whose "Used in" lists the image we came from (reverse direction).
  await expect(info.getByRole("heading", { name: "Used in · 2" })).toBeVisible();
  await info.getByRole("button", { name: "poster-alps-4k.png · Open this generation's result in the viewer" }).click();
  await expect(viewerTitle(page)).toHaveText("poster-alps-4k.png");
  await expect(path).toBeVisible();

  // Esc walks back: poster (via used-in) -> input -> original -> closed.
  await page.keyboard.press("Escape");
  await expect(viewerTitle(page)).toHaveText(inputTitle);
  await page.keyboard.press("Escape");
  await expect(viewerTitle(page)).toHaveText("poster-alps-4k.png");
  await expect(path).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer-overlay")).toHaveCount(0);
});

test("used-in from an upload opens the generation that consumed it", async ({ page }) => {
  await openViewerOn(page, "texture-confetti.webp");
  const info = viewer(page).getByRole("complementary", { name: "Image info" });
  await expect(info.getByRole("heading", { name: "Used in · 1" })).toBeVisible();
  await info.getByRole("button", { name: /Open this generation's result in the viewer$/ }).click();
  await expect(info.getByText("Flat-lay variant with confetti texture, top-down")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewerTitle(page)).toHaveText("texture-confetti.webp");
});

interface Img {
  id: number;
  filename: string;
  source: string;
}

async function generatedDefaults(page: import("@playwright/test").Page) {
  const body = await (await page.request.get("/api/images?limit=200")).json();
  return (body.images as Img[]).filter((i) => i.source === "generated" && /^gen-/.test(i.filename));
}

/** "Generated · MM-DD HH:MM:SS" in the page's timezone, from gen-<UTC ISO>.ext. */
async function expectedName(page: import("@playwright/test").Page, filename: string) {
  return page.evaluate((name) => {
    const m = /^gen-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(name)!;
    const d = new Date(`${m[1]}Z`);
    const p = (n: number) => String(n).padStart(2, "0");
    return `Generated · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, filename);
}

test("display names: default generated names show local time; renamed and uploaded keep their names", async ({
  page,
}) => {
  const gens = await generatedDefaults(page);
  expect(gens.length).toBeGreaterThan(5);
  const names = await libTiles(page).evaluateAll((els) => els.map((e) => e.getAttribute("alt") ?? ""));
  for (const g of gens.slice(0, 5)) {
    const base = await expectedName(page, g.filename);
    expect(names.some((n) => n === base || n.startsWith(`${base}.`)), `${base} among ${names.join(" | ")}`).toBe(true);
  }
  await expect((await shownLibTile(page, "poster-alps-4k.png"))).toBeVisible();
  await expect((await shownLibTile(page, "landscape-alps.jpg"))).toBeVisible();
  // The viewer uses the same name.
  await openViewerOn(page, "poster-alps-4k.png");
});

test("display names have no milliseconds", async ({ page }) => {
  // Lands with gitkeniwo/imagen#41 ("show generated image names to the second").
  test.fixme(true, "main still shows .mmm for default generated names until PR #41 is merged");
  const gens = await generatedDefaults(page);
  const names = await libTiles(page).evaluateAll((els) => els.map((e) => e.getAttribute("alt") ?? ""));
  for (const n of names.filter((x) => x.startsWith("Generated · "))) {
    expect(n).toMatch(/^Generated · \d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  for (const g of gens.slice(0, 5)) {
    expect(names).toContain(await expectedName(page, g.filename));
  }
});
