import { imgThumbUrl, type SeriesNode, type SeriesStats, type SeriesStatus } from "../api";
import { useI18n } from "../i18n";
import { seriesPathText, useSeries } from "../seriesStore";

// Small pieces shared by the Series page, History cards and the composer.

export const SERIES_COLORS = [
  "#ea580c", "#ca8a04", "#16a34a", "#0891b2",
  "#2563eb", "#7c3aed", "#db2777", "#475569",
];

/** Success share of finished attempts; cancellations are left out (#39). */
export function successRate(s: Pick<SeriesStats, "success" | "blocked" | "error">): number | null {
  const finished = s.success + s.blocked + s.error;
  return finished > 0 ? Math.round((s.success / finished) * 100) : null;
}

/** Sum the stats of a set of series (theme rows, filtered views). */
export function sumStats(items: SeriesStats[]): SeriesStats {
  const out: SeriesStats = {
    tries: 0, success: 0, blocked: 0, error: 0, aborted: 0, running: 0,
    records: 0, drafts: 0, last_at: null, strip: [], cover: [],
  };
  for (const s of items) {
    out.tries += s.tries;
    out.success += s.success;
    out.blocked += s.blocked;
    out.error += s.error;
    out.aborted += s.aborted;
    out.running += s.running;
    out.records += s.records;
    out.drafts += s.drafts;
    if (s.last_at && (!out.last_at || s.last_at > out.last_at)) out.last_at = s.last_at;
  }
  out.cover = items.flatMap((s) => s.cover.slice(0, 1)).slice(0, 3);
  return out;
}

export function SeriesDot({ color, size }: { color: string | null | undefined; size?: "lg" }) {
  return (
    <span
      className={`series-dot${size === "lg" ? " lg" : ""}`}
      style={{ background: color ?? undefined }}
      aria-hidden="true"
    />
  );
}

export function StatusStrip({ strip, max = 24 }: { strip: SeriesStatus[]; max?: number }) {
  const { t } = useI18n();
  const items = strip.slice(-max);
  if (items.length === 0) return <span className="series-strip empty" aria-hidden="true" />;
  const label = items.map((s) => t(`status_${s}`)).join(", ");
  return (
    <span className="series-strip" role="img" aria-label={t("series_recent_tries", { list: label })}>
      {items.map((s, i) => (
        <i key={i} className={s} />
      ))}
    </span>
  );
}

/** Left: one large image; right: two small ones. Fewer images degrade to a
 *  single image or an empty tile. */
export function Collage({ node, size = "card" }: { node: Pick<SeriesNode, "cover">; size?: "card" | "mini" }) {
  const [a, b, c] = node.cover;
  if (!a) return <div className={`series-collage ${size} empty`} aria-hidden="true" />;
  if (!b) {
    return (
      <div className={`series-collage ${size} single`} aria-hidden="true">
        <img src={imgThumbUrl(a)} alt="" loading="lazy" draggable={false} />
      </div>
    );
  }
  return (
    <div className={`series-collage ${size}`} aria-hidden="true">
      <img className="main" src={imgThumbUrl(a)} alt="" loading="lazy" draggable={false} />
      <img src={imgThumbUrl(b)} alt="" loading="lazy" draggable={false} />
      {c ? <img src={imgThumbUrl(c)} alt="" loading="lazy" draggable={false} /> : <span />}
    </div>
  );
}

/** "● Perfume poster" pill on History cards; title shows the full path. */
export function SeriesChip({ seriesId }: { seriesId: number | null | undefined }) {
  const { t } = useI18n();
  const { get } = useSeries();
  const path = get(seriesId);
  if (!path) return null;
  return (
    <span className="series-chip" title={seriesPathText(path, t("series_no_theme"))}>
      <SeriesDot color={path.color} />
      <span>{path.name}</span>
    </span>
  );
}
