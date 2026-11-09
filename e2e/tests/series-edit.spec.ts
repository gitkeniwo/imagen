import {
  contextMenu,
  expect,
  openApp,
  rightClick,
  sidebarTab,
  test,
} from "../fixtures";

// Every test starts from a fresh copy: these tests create series and edit
// drafts / history records.
test.use({ freshLibrary: true });

async function createSeries(
  page: import("@playwright/test").Page,
  themeName: string,
  seriesName: string,
) {
  const themeRes = await page.request.post("/api/series", {
    data: { kind: "theme", name: themeName },
  });
  expect(themeRes.ok()).toBeTruthy();
  const theme = await themeRes.json();

  const seriesRes = await page.request.post("/api/series", {
    data: { kind: "series", name: seriesName, parentId: theme.id },
  });
  expect(seriesRes.ok()).toBeTruthy();
  const series = await seriesRes.json();
  return { theme, series };
}

async function openSeriesTab(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: "Series", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Series", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
}

async function pickSeries(
  page: import("@playwright/test").Page,
  seriesName: string,
) {
  const option = page
    .locator(".series-picker-row[role=option]:not(.create)")
    .filter({ hasText: seriesName });
  await expect(option).toBeVisible();
  await option.click();
}

test("draft editor assigns a series", async ({ page }) => {
  const prompt = "E2E draft series assignment";
  const { series } = await createSeries(page, "E2E Draft Theme", "E2E Draft Series");
  const draftRes = await page.request.post("/api/drafts", {
    data: {
      prompt,
      provider: "vertex",
      model: "gemini-3-pro-image",
      outputFormat: "image/jpeg",
      skipIfPrecedingSucceeds: false,
      inputImageIds: [],
      outputImageIds: [],
      tagIds: [],
      seriesId: null,
    },
  });
  expect(draftRes.ok()).toBeTruthy();
  const draft = await draftRes.json();

  await openApp(page);
  await sidebarTab(page, "Drafts");
  const card = page.getByRole("article").filter({ hasText: prompt });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit draft" }).click();

  const dialog = page.locator(".draft-editor-modal");
  await expect(dialog).toBeVisible();
  await dialog.locator(".series-pill").click();
  await page
    .getByRole("combobox", { name: "Search, or type theme/series" })
    .fill("E2E Draft Series");
  await pickSeries(page, "E2E Draft Series");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(async () => {
      const body = await (await page.request.get("/api/drafts?limit=200")).json();
      return body.drafts.find((item: { id: number }) => item.id === draft.id)?.series_id;
    })
    .toBe(series.id);
});

test("history editor assigns and clears a series", async ({ page }) => {
  const prompt = "E2E manual record series edit";
  const { theme, series } = await createSeries(
    page,
    "E2E Edit Theme",
    "E2E Edit Series",
  );
  const oldSeriesRes = await page.request.post("/api/series", {
    data: { kind: "series", name: "E2E Old Series", parentId: theme.id },
  });
  expect(oldSeriesRes.ok()).toBeTruthy();
  const oldSeries = await oldSeriesRes.json();
  const images = (await (await page.request.get("/api/images?limit=1")).json()).images;
  const output = images[0];
  expect(output).toBeTruthy();
  const createdRes = await page.request.post("/api/generations/manual", {
    data: {
      prompt,
      provider: "vertex",
      model: "gemini-3-pro-image",
      aspectRatio: "1:1",
      resolution: "1K",
      status: "success",
      source: "manual",
      inputImageIds: [],
      outputImageId: output.id,
      seriesId: oldSeries.id,
    },
  });
  expect(createdRes.ok()).toBeTruthy();
  const created = await createdRes.json();

  await openApp(page);
  await sidebarTab(page, "History");
  await page.getByPlaceholder("Search prompt…").fill(prompt);
  const item = page.getByRole("article").filter({ hasText: prompt });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Edit note & tags" }).click();

  const dialog = page.locator(".import-modal");
  await expect(dialog).toBeVisible();
  await dialog.locator(".series-pill").click();
  await page
    .getByRole("combobox", { name: "Search, or type theme/series" })
    .fill("E2E Edit Series");
  await pickSeries(page, "E2E Edit Series");
  await expect(dialog.locator(".series-edit-move-hint")).toContainText(
    "Changing it moves this record",
  );
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(async () => {
      const body = await (
        await page.request.get(`/api/generations?q=${encodeURIComponent(prompt)}`)
      ).json();
      return body.generations.find(
        (item: { id: number }) => item.id === created.id,
      )?.series_id;
    })
    .toBe(series.id);

  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Edit note & tags" }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator(".series-pill").click();
  await page.getByRole("option", { name: "No series", exact: true }).click();
  await dialog.getByRole("button", { name: /^Save/ }).click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(async () => {
      const body = await (
        await page.request.get(`/api/generations?q=${encodeURIComponent(prompt)}`)
      ).json();
      return body.generations.find(
        (item: { id: number }) => item.id === created.id,
      )?.series_id;
    })
    .toBeNull();
});

test("series cards and list rows preview the latest prompt", async ({ page }) => {
  const { series } = await createSeries(page, "E2E Hover Theme", "E2E Hover Series");
  const latest = (await (await page.request.get("/api/generations?limit=1")).json())
    .generations[0];
  expect(latest).toBeTruthy();
  const assigned = await page.request.post(`/api/series/${series.id}/assign`, {
    data: { generationIds: [latest.id] },
  });
  expect(assigned.ok()).toBeTruthy();

  await openApp(page);
  await openSeriesTab(page);
  const card = page.locator('.series-card[aria-label="E2E Hover Series"]');
  await expect(card).toBeVisible();
  await card.hover();
  const peek = page.locator(".series-prompt-peek");
  await expect(peek).toBeVisible({ timeout: 8_000 });
  await expect(peek).toContainText(latest.prompt.slice(0, 40));
  await page.mouse.move(2, 2);
  await expect(peek).toHaveCount(0);

  await page.locator(".view-seg").getByRole("button", { name: "List" }).click();
  const row = page.locator(".series-tr.item").filter({ hasText: "E2E Hover Series" });
  await expect(row).toBeVisible();
  await row.hover();
  await expect(peek).toBeVisible({ timeout: 8_000 });
  await expect(peek).toContainText(latest.prompt.slice(0, 40));
});

test("list view theme rows expose + Series and the shared theme menu", async ({
  page,
}) => {
  const themeName = "E2E List Theme";
  const { theme } = await createSeries(page, themeName, "E2E List Series");

  await openApp(page);
  await openSeriesTab(page);
  await page.locator(".view-seg").getByRole("button", { name: "List" }).click();
  const row = page.locator(".series-tr.theme").filter({ hasText: themeName });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "+ Series" })).toBeVisible();

  await row.getByRole("button", { name: "+ Series" }).click();
  const dialog = page.locator(".series-modal");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#series-name")).toBeVisible();
  await expect(dialog.locator("select")).toHaveValue(String(theme.id));
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await row.getByRole("button", { name: "Theme actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  for (const item of [
    `New series in ${themeName}`,
    "Rename",
    "Archive theme",
    "Delete theme",
  ]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
});

test("an archived bound series is marked in the field, tab and Generate hint", async ({
  page,
}) => {
  const seriesName = "E2E Archived Series";
  await createSeries(page, "E2E Archive Theme", seriesName);
  await openApp(page);

  const composer = page.locator(".composer").first();
  await composer.locator(".series-pill").click();
  await page
    .getByRole("combobox", { name: "Search, or type theme/series" })
    .fill(seriesName);
  await pickSeries(page, seriesName);

  await openSeriesTab(page);
  const card = page.locator(`.series-card[aria-label="${seriesName}"]`);
  await expect(card).toBeVisible();
  await rightClick(card);
  await contextMenu(page).getByRole("menuitem", { name: "Archive", exact: true }).click();

  await expect(composer.locator(".series-pill.archived")).toBeVisible();
  await expect(composer.locator(".series-field-archived")).toContainText(
    "Archived — new tries still go here.",
  );
  const archivedTab = page.locator(".composer-tabs .ws-tab-wrap.series-archived");
  await expect(archivedTab).toBeVisible();
  await expect(archivedTab.locator(".ws-tab-series.archived .icon")).toBeVisible();
  await expect(composer.locator(".series-next-hint.archived")).toBeVisible();

  const prompt = "E2E archived series still generates";
  await composer.getByRole("textbox", { name: "Prompt" }).fill(prompt);
  await composer.getByRole("button", { name: /^Generate/ }).click();
  await expect(page.getByRole("article").filter({ hasText: prompt })).toBeVisible({
    timeout: 20_000,
  });

  await composer.getByRole("button", { name: "Unarchive" }).click();
  await expect(composer.locator(".series-pill.archived")).toHaveCount(0);
});
