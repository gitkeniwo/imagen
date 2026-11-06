import { expect, type Page } from "@playwright/test";

export async function submitPrompt(page: Page, prompt: string) {
  const box = page.getByRole("textbox", { name: "Prompt" });
  await box.fill(prompt);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(queueCard(page, prompt)).toBeVisible();
}

export const queueCard = (page: Page, prompt: string) =>
  page.locator(".queue-grid article").filter({ hasText: prompt }).first();
