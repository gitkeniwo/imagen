import { useEffect, useMemo, useState } from "react";
import { api, MODELS, StatPeriod, Stats } from "../api";
import { useI18n } from "../i18n";

// Full-screen usage dashboard (mirrors FullscreenManager's overlay shell).
// A single period selector (day/week/month/year/all) scopes the WHOLE panel —
// cards, status & model breakdowns, the trend chart AND the cost estimate.
// Figures are facts from the local DB; cost is a clearly-labelled estimate from
// user-editable unit prices (the app can't see real billing).

const PRICES_KEY = "imagen-cost-prices";
const PERIODS: StatPeriod[] = ["day", "week", "month", "year", "all"];

const STATUS_ORDER = ["success", "blocked", "error", "aborted", "note"] as const;
const STATUS_CLASS: Record<string, string> = {
  success: "success",
  blocked: "blocked",
  error: "error",
  aborted: "aborted",
  note: "note",
};

interface PriceRow {
  key: string;
  model: string;
  resolution: string | null;
  label: string;
  defaultPrice: number;
}
const PRICE_ROWS: PriceRow[] = [
  { key: "flash", model: "gemini-2.5-flash-image", resolution: null, label: "Nano Banana (Flash)", defaultPrice: 0.039 },
  { key: "pro-1K", model: "gemini-3-pro-image-preview", resolution: "1K", label: "Nano Banana Pro · 1K", defaultPrice: 0.134 },
  { key: "pro-2K", model: "gemini-3-pro-image-preview", resolution: "2K", label: "Nano Banana Pro · 2K", defaultPrice: 0.134 },
  { key: "pro-4K", model: "gemini-3-pro-image-preview", resolution: "4K", label: "Nano Banana Pro · 4K", defaultPrice: 0.24 },
];

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const modelShort = (id: string) =>
  MODELS.find((m) => m.id === id)?.label ?? id.replace("-image", "").replace("-preview", "");

export default function UsageDashboard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [currency, setCurrency] = useState("$");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [period, setPeriod] = useState<StatPeriod>("all");

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

  // Successful generations per price-row (model + resolution; null res → 1K).
  const successCounts = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(PRICE_ROWS.map((r) => [r.key, 0]));
    for (const cb of p?.cost_basis ?? []) {
      const res = cb.resolution ?? "1K";
      const row =
        cb.model === "gemini-2.5-flash-image"
          ? "flash"
          : PRICE_ROWS.find((r) => r.model === cb.model && r.resolution === res)?.key;
      if (row) counts[row] = (counts[row] ?? 0) + cb.count;
    }
    return counts;
  }, [p]);

  const costTotal = PRICE_ROWS.reduce(
    (sum, r) => sum + (successCounts[r.key] ?? 0) * (prices[r.key] ?? 0),
    0,
  );

  const successRate = p && p.total > 0 ? Math.round(((p.by_status.success ?? 0) / p.total) * 100) : 0;
  const chartPoints = p?.chart ?? [];
  const chartMax = Math.max(1, ...chartPoints.map((d) => d.total));

  return (
    <div className="manager-overlay" role="dialog" aria-modal="true">
      <div className="manager-header">
        <h3 style={{ margin: 0 }}>📊 {t("usage_title")}</h3>
        <div className="seg density-seg" title={t("usage_period")}>
          {PERIODS.map((b) => (
            <button key={b} className={period === b ? "on" : ""} onClick={() => setPeriod(b)}>
              {t(`bucket_${b}`)}
            </button>
          ))}
        </div>
        {stats?.first_at && (
          <span className="muted small">
            {t("usage_range", {
              from: (stats.first_at ?? "").slice(0, 10),
              to: (stats.last_at ?? "").slice(0, 10),
            })}
          </span>
        )}
        <button className="manager-close" title={t("close")} onClick={onClose}>
          ×
        </button>
      </div>

      <div className="manager-body">
        {err && <div className="notice error">{err}</div>}
        {!stats || !p ? (
          <div className="panel muted">
            <span className="spinner" /> {t("loading")}
          </div>
        ) : (
          <div className="dash">
            {/* Stat cards (scoped to the selected period) */}
            <div className="dash-cards">
              <StatCard label={t("stat_total")} value={p.total} />
              <StatCard label={t("stat_success_rate")} value={`${successRate}%`} />
              <StatCard label={t("status_success")} value={p.by_status.success ?? 0} />
              <StatCard
                label={t("stat_images")}
                value={p.images.total}
                sub={`${t("tag_upload")} ${p.images.by_source.upload ?? 0} · ${t("tag_generated")} ${p.images.by_source.generated ?? 0}`}
              />
              <StatCard label={t("stat_storage")} value={fmtBytes(p.images.bytes)} />
              <StatCard label={t("stat_tags")} value={stats.tags} />
            </div>

            {p.total === 0 ? (
              <div className="panel muted">{t("usage_empty_period")}</div>
            ) : (
              <>
                <div className="dash-grid">
                  <div className="panel">
                    <h4 className="dash-h">{t("by_status_title")}</h4>
                    {STATUS_ORDER.filter((s) => (p.by_status[s] ?? 0) > 0).map((s) => (
                      <BarRow
                        key={s}
                        label={t(`status_${s}`)}
                        value={p.by_status[s] ?? 0}
                        total={p.total}
                        cls={STATUS_CLASS[s]}
                      />
                    ))}
                  </div>
                  <div className="panel">
                    <h4 className="dash-h">{t("by_model_title")}</h4>
                    {Object.entries(p.by_model)
                      .sort((a, b) => b[1] - a[1])
                      .map(([m, c]) => (
                        <BarRow key={m} label={modelShort(m)} value={c} total={p.total} cls="running" />
                      ))}
                  </div>
                </div>

                {/* Trend chart for the selected window */}
                <div className="panel">
                  <h4 className="dash-h">{t("usage_series")}</h4>
                  <div className="daily-chart">
                    {chartPoints.map((d, i) => (
                      <div key={`${d.label}-${i}`} className="daily-col" title={`${d.label}: ${d.total}`}>
                        <div className="daily-bar" style={{ height: `${(d.total / chartMax) * 100}%` }}>
                          <div
                            className="daily-bar-ok"
                            style={{ height: d.total ? `${(d.success / d.total) * 100}%` : "0%" }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="daily-axis">
                    <span className="muted small">{chartPoints[0]?.label}</span>
                    <span className="muted small">{chartPoints[chartPoints.length - 1]?.label}</span>
                  </div>
                </div>
              </>
            )}

            {/* Cost estimate (scoped to the selected period) */}
            <div className="panel">
              <h4 className="dash-h">{t("cost_estimate")}</h4>
              <p className="muted small" style={{ marginTop: 0 }}>{t("cost_estimate_note")}</p>
              <p className="muted small">{t("cost_example_note")}</p>
              <div className="cost-currency-row">
                <label style={{ margin: 0 }}>{t("cost_currency")}</label>
                <input
                  className="cost-currency-input"
                  value={currency}
                  onChange={(e) => setCur(e.target.value.slice(0, 4))}
                />
              </div>
              <table className="cost-table">
                <thead>
                  <tr>
                    <th>{t("model")}</th>
                    <th>{t("cost_count")}</th>
                    <th>{t("cost_unit_price")}</th>
                    <th>{t("cost_subtotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICE_ROWS.map((r) => {
                    const count = successCounts[r.key] ?? 0;
                    const price = prices[r.key] ?? 0;
                    return (
                      <tr key={r.key}>
                        <td>{r.label}</td>
                        <td>{count}</td>
                        <td>
                          <span className="cost-cur">{currency}</span>
                          <input
                            type="number"
                            min={0}
                            step="0.001"
                            className="cost-price-input"
                            value={price}
                            onChange={(e) => setPrice(r.key, Math.max(0, Number(e.target.value) || 0))}
                          />
                        </td>
                        <td>{currency}{(count * price).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} style={{ textAlign: "right", fontWeight: 600 }}>{t("cost_total")}</td>
                    <td style={{ fontWeight: 700 }}>{currency}{costTotal.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="muted small stat-sub">{sub}</div>}
    </div>
  );
}

function BarRow({ label, value, total, cls }: { label: string; value: number; total: number; cls: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="bar-row">
      <div className="bar-head">
        <span>{label}</span>
        <span className="muted small">{value}</span>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
