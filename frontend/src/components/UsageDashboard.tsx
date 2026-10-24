import { useEffect, useMemo, useState } from "react";
import { api, CostBasisRow, MODELS, StatPeriod, Stats } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/Button";
import Segmented from "./ui/Segmented";
import { useBackLayer } from "../backStack";

// Full-screen usage dashboard (mirrors FullscreenManager's overlay shell).
// A single period selector (day/week/month/year/all) scopes the WHOLE panel —
// KPIs, the stacked status chart, model & failure breakdowns AND the cost rail.
// Figures are facts from the local DB; cost is a clearly-labelled estimate from
// user-editable unit prices (the app can't see real billing).

const PRICES_KEY = "imagen-cost-prices";
const PERIODS: StatPeriod[] = ["day", "week", "month", "year", "all"];
// Bucket unit per period (matches backend `_chart`).
const SERIES_UNIT: Record<StatPeriod, string> = {
  day: "hour",
  week: "day",
  month: "day",
  year: "month",
  all: "year",
};
// Stacked from the baseline up; whatever is left (aborted …) sits on top.
const STACK = ["success", "blocked", "error"] as const;

interface PriceRow {
  key: string;
  model: string;
  resolution: string | null;
  label: string;
  defaultPrice: number;
}
const PRICE_ROWS: PriceRow[] = [
  { key: "flash", model: "gemini-2.5-flash-image", resolution: null, label: "Nano Banana", defaultPrice: 0.039 },
  { key: "pro-1K", model: "gemini-3-pro-image", resolution: "1K", label: "Pro · 1K", defaultPrice: 0.134 },
  { key: "pro-2K", model: "gemini-3-pro-image", resolution: "2K", label: "Pro · 2K", defaultPrice: 0.134 },
  { key: "pro-4K", model: "gemini-3-pro-image", resolution: "4K", label: "Pro · 4K", defaultPrice: 0.24 },
];

// Keep the totals for generations made before the Preview model was retired.
const PRO_IMAGE_MODEL_IDS = new Set(["gemini-3-pro-image", "gemini-3-pro-image-preview"]);

function loadPrices(): { currency: string; prices: Record<string, number> } {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICES_KEY) || "{}");
    const prices: Record<string, number> = {};
    for (const r of PRICE_ROWS) {
      const v = Number(saved.prices?.[r.key]);
      prices[r.key] = Number.isFinite(v) ? v : r.defaultPrice;
    }
    return { currency: typeof saved.currency === "string" ? saved.currency : "$", prices };
  } catch {
    return { currency: "$", prices: Object.fromEntries(PRICE_ROWS.map((r) => [r.key, r.defaultPrice])) };
  }
}

// Map raw (model, resolution) success counts onto the editable price rows.
function countsByPriceRow(rows: CostBasisRow[] | undefined): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(PRICE_ROWS.map((r) => [r.key, 0]));
  for (const cb of rows ?? []) {
    const res = cb.resolution ?? "1K";
    const key = cb.model === "gemini-2.5-flash-image"
      ? "flash"
      : PRO_IMAGE_MODEL_IDS.has(cb.model)
        ? PRICE_ROWS.find((r) => r.resolution === res)?.key
        : undefined;
    if (key) counts[key] = (counts[key] ?? 0) + cb.count;
  }
  return counts;
}

function costOf(rows: CostBasisRow[] | undefined, prices: Record<string, number>): number {
  const counts = countsByPriceRow(rows);
  return PRICE_ROWS.reduce((sum, r) => sum + (counts[r.key] ?? 0) * (prices[r.key] ?? 0), 0);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const modelShort = (id: string) =>
  MODELS.find((m) => m.id === id)?.label ?? id.replace("-image", "").replace("-preview", "");

export default function UsageDashboard({ onClose }: { onClose: () => void }) {
  const { t, reason } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [currency, setCurrency] = useState("$");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [period, setPeriod] = useState<StatPeriod>("all");
  const [hover, setHover] = useState<number | null>(null);
  useBackLayer(true, onClose);

  useEffect(() => {
    const { currency, prices } = loadPrices();
    setCurrency(currency);
    setPrices(prices);
  }, []);

  useEffect(() => {
    api.getStats().then(setStats).catch((e) => setErr((e as Error).message));
  }, []);

  // Esc closes; lock background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("manager-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("manager-open");
    };
  }, [onClose]);

  useEffect(() => setHover(null), [period]);

  const setPrice = (key: string, value: number) =>
    setPrices((p) => {
      const next = { ...p, [key]: value };
      localStorage.setItem(PRICES_KEY, JSON.stringify({ currency, prices: next }));
      return next;
    });
  const setCur = (c: string) => {
    setCurrency(c);
    localStorage.setItem(PRICES_KEY, JSON.stringify({ currency: c, prices }));
  };

  const p = stats?.periods[period];
  const library = stats?.periods.all.images;

  // Successful generations per price-row (model + resolution; null res → 1K).
  const successCounts = useMemo(() => countsByPriceRow(p?.cost_basis), [p]);
  const costTotal = PRICE_ROWS.reduce(
    (sum, r) => sum + (successCounts[r.key] ?? 0) * (prices[r.key] ?? 0),
    0,
  );
  const money = (v: number) => `${currency}${v.toFixed(2)}`;

  const ok = p?.by_status.success ?? 0;
  const successRate = p && p.total > 0 ? Math.round((ok / p.total) * 100) : 0;
  const chartPoints = p?.chart ?? [];
  const chartMax = Math.max(1, ...chartPoints.map((d) => d.total));
  const hovered = hover !== null ? chartPoints[hover] : undefined;
  // Label roughly eight ticks however many buckets there are.
  const tickEvery = Math.max(1, Math.ceil(chartPoints.length / 8));
  const showCounts = chartPoints.length <= 12;
  const modelRows = Object.entries(p?.by_model ?? {}).sort((a, b) => b[1] - a[1]);
  const modelMax = Math.max(1, ...modelRows.map(([, c]) => c));

  return (
    <div className="manager-overlay usage-overlay" role="dialog" aria-modal="true">
      <div className="manager-header usage-header">
        <h3 className="m-0 manager-title">
          <Icon name="usage" /> {t("usage_title")}
        </h3>
        <div className="usage-period">
          <Segmented
            title={t("usage_period")}
            value={period}
            onChange={setPeriod}
            options={PERIODS.map((b) => ({ value: b, label: t(`bucket_${b}`) }))}
          />
          {stats?.first_at && (
            <span className="muted small tabular">
              {t("usage_range", {
                from: (stats.first_at ?? "").slice(0, 10),
                to: (stats.last_at ?? "").slice(0, 10),
              })}
            </span>
          )}
        </div>
        <IconButton
          className="manager-close"
          variant="outline"
          size="md"
          icon="close"
          label={t("close")}
          onClick={onClose}
        />
      </div>

      {err && <div className="notice error usage-err">{err}</div>}
      {!stats || !p || !library ? (
        <div className="manager-body">
          <div className="panel muted">
            <span className="spinner" /> {t("loading")}
          </div>
        </div>
      ) : (
        <div className="usage-layout">
          <main className="usage-main">
            <div className="usage-kpis">
              <Kpi
                label={t("stat_total")}
                value={p.total}
                sub={t("usage_kpi_success_sub", { n: ok })}
              />
              <Kpi
                label={t("stat_success_rate")}
                value={`${successRate}%`}
                sub={t("usage_kpi_fail_sub", { b: p.by_status.blocked ?? 0, e: p.by_status.error ?? 0 })}
              />
              <Kpi
                label={t("usage_kpi_library")}
                value={library.total}
                sub={t("usage_kpi_library_sub", { size: fmtBytes(library.bytes), tags: stats.tags })}
              />
              <Kpi
                label={t("usage_kpi_new")}
                value={`+${p.images.total}`}
                sub={t("usage_kpi_new_sub", {
                  u: p.images.by_source.upload ?? 0,
                  g: p.images.by_source.generated ?? 0,
                })}
              />
            </div>

            {/* Stacked status bars for the selected window */}
            <section className="usage-card">
              <div className="usage-card-head">
                <h4 className="m-0">{t(`usage_series_${SERIES_UNIT[period]}`)}</h4>
                <span className="spacer" />
                {STACK.map((s) => (
                  <span key={s} className="usage-legend">
                    <i className={`usage-swatch ${s}`} />
                    {t(`status_${s}`)}
                  </span>
                ))}
              </div>
              <div className="usage-chart-wrap" onMouseLeave={() => setHover(null)}>
                <div className="usage-chart">
                  {chartPoints.map((d, i) => {
                    const rest = d.total - d.success - d.blocked - d.error;
                    return (
                      <div
                        key={`${d.label}-${i}`}
                        className={`usage-col${hover === i ? " on" : ""}`}
                        onMouseEnter={() => setHover(i)}
                      >
                        {showCounts && d.total > 0 && <span className="usage-col-n">{d.total}</span>}
                        <div
                          className={`usage-stack${d.total ? "" : " empty"}`}
                          style={{ height: d.total ? `${Math.max(3, (d.total / chartMax) * 88)}%` : undefined }}
                        >
                          {rest > 0 && <span className="other" style={{ flexGrow: rest }} />}
                          <span className="error" style={{ flexGrow: d.error }} />
                          <span className="blocked" style={{ flexGrow: d.blocked }} />
                          <span className="success" style={{ flexGrow: d.success }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {hovered && (
                  <div
                    className="daily-tip"
                    style={{
                      left: `${((hover! + 0.5) / chartPoints.length) * 100}%`,
                      // Keep the box inside the card at both ends.
                      transform: `translateX(${
                        hover! < chartPoints.length / 4
                          ? "0"
                          : hover! > (chartPoints.length * 3) / 4
                            ? "-100%"
                            : "-50%"
                      })`,
                    }}
                  >
                    <div className="daily-tip-label">{hovered.label}</div>
                    <div className="daily-tip-row">
                      <span>{t("stat_total")}</span>
                      <b>{hovered.total}</b>
                    </div>
                    {STACK.filter((s) => hovered[s] > 0).map((s) => (
                      <div key={s} className="daily-tip-row">
                        <span><i className={`usage-swatch ${s}`} /> {t(`status_${s}`)}</span>
                        <b>{hovered[s]}</b>
                      </div>
                    ))}
                    <div className="daily-tip-row cost">
                      <span>{t("cost_estimate")}</span>
                      <b>≈ {money(costOf(hovered.cost_basis, prices))}</b>
                    </div>
                  </div>
                )}
              </div>
              <div className="usage-ticks">
                {chartPoints.map((d, i) => (
                  <span key={`${d.label}-${i}`}>{i % tickEvery === 0 ? d.label : ""}</span>
                ))}
              </div>
            </section>

            <div className="usage-pair">
              <section className="usage-card">
                <h4 className="m-0">{t("by_model_title")}</h4>
                {modelRows.length === 0 && <p className="muted small m-0">{t("usage_empty_period")}</p>}
                {modelRows.map(([m, c]) => (
                  <div key={m} className="usage-model">
                    <span>{modelShort(m)}</span>
                    <b>{c}</b>
                    <span className="usage-model-track">
                      <span style={{ width: `${(c / modelMax) * 100}%` }} />
                    </span>
                  </div>
                ))}
              </section>
              <section className="usage-card">
                <h4 className="m-0">{t("usage_failures")}</h4>
                {p.failures.length === 0 && <p className="muted small m-0">{t("usage_no_failures")}</p>}
                {p.failures.map((f, i) => {
                  const label = reason(f.code) || reason(f.message) || f.message || f.code || t("no_output");
                  return (
                    <div key={i} className="usage-reason" title={label}>
                      <span>{label}</span>
                      <b>{f.count}</b>
                    </div>
                  );
                })}
              </section>
            </div>
          </main>

          {/* Cost rail (scoped to the selected period) */}
          <aside className="usage-cost" aria-label={t("cost_estimate")}>
            <div className="usage-cost-total">
              <span className="usage-kpi-label">{t("cost_period")}</span>
              <span className="usage-cost-value">{money(costTotal)}</span>
              <span className="muted small">{t("cost_lower_bound")}</span>
            </div>
            <hr className="usage-rule" />
            <div className="usage-cost-head">
              <h4 className="m-0">{t("cost_prices")}</h4>
              <span className="spacer" />
              <label htmlFor="usage-currency" className="m-0 muted small">{t("cost_currency")}</label>
              <input
                id="usage-currency"
                className="usage-currency"
                value={currency}
                onChange={(e) => setCur(e.target.value.slice(0, 4))}
              />
            </div>
            <div className="usage-prices">
              {PRICE_ROWS.map((r) => {
                const count = successCounts[r.key] ?? 0;
                const price = prices[r.key] ?? 0;
                return (
                  <div key={r.key} className="usage-price">
                    <span className="usage-price-label">{r.label}</span>
                    <label className="usage-price-input">
                      <span className="muted">{currency}</span>
                      <input
                        type="number"
                        min={0}
                        step="0.001"
                        aria-label={`${r.label} ${t("cost_prices")}`}
                        value={price}
                        onChange={(e) => setPrice(r.key, Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <span className="muted small tabular">
                      {t("cost_row_sub", { n: count, sub: money(count * price) })}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="muted small m-0">{t("cost_example_note")}</p>
          </aside>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div className="usage-kpi">
      <span className="usage-kpi-label">{label}</span>
      <span className="usage-kpi-value">{value}</span>
      <span className="muted small">{sub}</span>
    </div>
  );
}
