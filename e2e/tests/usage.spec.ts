import { expect, openApp, test } from "../fixtures";
import { queueCard, submitPrompt } from "../queue";

interface Period {
  total: number;
  by_status: Record<string, number>;
  chart: { label: string; total: number; success: number; blocked: number; error: number; aborted: number; other: number }[];
}

test("usage counts cancelled generations consistently in every period", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("imagen-undo-send-seconds", "0"));
  await openApp(page);

  // Two slow fake generations, both cancelled while running.
  for (const prompt of ["e2e cancel A [slow]", "e2e cancel B [slow]"]) {
    await submitPrompt(page, prompt);
  }
  for (const prompt of ["e2e cancel A [slow]", "e2e cancel B [slow]"]) {
    const card = queueCard(page, prompt);
    await card.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 15_000 });
  }
  for (const prompt of ["e2e cancel A [slow]", "e2e cancel B [slow]"]) {
    await expect(queueCard(page, prompt).locator(".hcard-status-label")).toHaveText("Cancelled", { timeout: 20_000 });
  }
  await expect
    .poll(async () => (await (await page.request.get("/api/stats")).json()).periods.all.by_status.aborted ?? 0)
    .toBe(2);

  const stats = await (await page.request.get("/api/stats")).json();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  const dash = page.locator(".usage-overlay");
  await expect(dash).toBeVisible();

  const labels: Record<string, string> = { day: "Day", week: "Week", month: "Month", year: "Year", all: "All" };
  for (const [period, label] of Object.entries(labels)) {
    await dash.locator(".usage-period").getByRole("button", { name: label, exact: true }).click();
    const p: Period = stats.periods[period];
    const s = p.by_status;
    const ok = s.success ?? 0;
    const blocked = s.blocked ?? 0;
    const failed = s.error ?? 0;
    const cancelled = s.aborted ?? 0;

    await test.step(`${period}: totals`, async () => {
      expect(p.total, "total = success + blocked + error + cancelled").toBe(ok + blocked + failed + cancelled);
      const kpis = dash.locator(".usage-kpi");
      await expect(kpis.nth(0).locator(".usage-kpi-value")).toHaveText(String(p.total));
      await expect(kpis.nth(0)).toContainText(`${ok} succeeded`);
      const rate = ok + blocked + failed > 0 ? Math.round((ok / (ok + blocked + failed)) * 100) : 0;
      await expect(kpis.nth(1).locator(".usage-kpi-value")).toHaveText(`${rate}%`);
      expect(cancelled).toBe(2);
      await expect(kpis.nth(1)).toContainText(`${blocked} blocked · ${failed} failed · ${cancelled} cancelled`);
    });

    await test.step(`${period}: chart`, async () => {
      // Each bar's segments add up to that bar's total, and the bars add up to the period.
      let sum = 0;
      for (const d of p.chart) {
        expect(d.success + d.blocked + d.error + d.aborted + d.other, d.label).toBe(d.total);
        sum += d.total;
      }
      expect(sum).toBe(p.total);
      const cols = await dash.locator(".usage-col").evaluateAll((els) =>
        els.map((col) => {
          const grow = [...col.querySelectorAll<HTMLElement>(".usage-stack > span")].reduce(
            (acc, el) => acc + (Number(el.style.flexGrow) || 0),
            0,
          );
          const n = col.querySelector(".usage-col-n")?.textContent;
          return { grow, n: n == null ? null : Number(n) };
        }),
      );
      expect(cols.length).toBe(p.chart.length);
      cols.forEach((c, i) => {
        expect(c.grow, `bar ${p.chart[i].label}`).toBe(p.chart[i].total);
        if (c.n !== null) expect(c.n).toBe(p.chart[i].total);
      });
      await expect(dash.locator(".usage-card-head .usage-legend")).toContainText(["Cancelled"]);
    });
  }
});
