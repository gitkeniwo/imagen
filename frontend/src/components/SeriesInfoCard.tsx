import { useEffect, useMemo, useState } from "react";
import { api, type ImageSeriesEntry, seriesApi } from "../api";
import { useI18n } from "../i18n";
import { fetchImageSeries, useSeriesNav } from "../seriesContext";
import { useSeries } from "../seriesStore";
import { Collage, SeriesDot, StatusStrip, successRate } from "./SeriesBits";
import type { SeriesTarget, useSeriesActions } from "./SeriesMenu";
import { useToast } from "./Toast";
import Icon from "./ui/Icon";

// series-v2 B1a: "what is this series and where does this record sit in it".
// Same content as a desktop popover and a phone sheet (SeriesBadge decides).

/** What the card describes. Records live in one series; images in several. */
export type SeriesSubject =
  | { kind: "record"; generationId: number; seriesId: number }
  | { kind: "draft"; draftId: number; seriesId: number }
  | { kind: "image"; imageId: number; entries?: ImageSeriesEntry[] }
  // A queue task: its snapshot series; the record is found by its output.
  | { kind: "task"; seriesId: number; imageId?: number | null; clientTaskId: string };

interface Entry {
  seriesId: number;
  role: "output" | "input";
  seq: number | null;
  generationId: number | null;
  /** vK (series-v2 B3), outputs only. */
  version?: number | null;
}

function initialEntries(subject: SeriesSubject, fixed?: number | null): Entry[] {
  let list: Entry[];
  if (subject.kind === "image") {
    list = (subject.entries ?? []).map((e) => ({
      seriesId: e.seriesId,
      role: e.role,
      seq: e.seq,
      generationId: e.generationId,
      version: e.version ?? null,
    }));
  } else {
    list = [
      {
        seriesId: subject.seriesId,
        role: "output",
        seq: null,
        generationId: subject.kind === "record" ? subject.generationId : null,
      },
    ];
  }
  return fixed ? list.filter((e) => e.seriesId === fixed) : list;
}

/** #N label for one entry: "#12 · v4" or "input of #2". */
export function entryPosition(
  entry: { role: "output" | "input"; seq: number | null; version?: number | null },
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (entry.seq == null) return null;
  if (entry.role === "input") return t("sv2_input_of", { n: entry.seq });
  return entry.version ? t("sv2_seq_version", { n: entry.seq, k: entry.version }) : `#${entry.seq}`;
}

export default function SeriesInfoCard({
  subject,
  fixedSeriesId,
  variant,
  onClose,
  actions,
}: {
  /** Owned by the (persistent) opener, so its dialogs outlive the card. */
  actions: ReturnType<typeof useSeriesActions>;
  subject: SeriesSubject;
  /** Only describe this series (Viewer opened from a series). */
  fixedSeriesId?: number | null;
  variant: "popover" | "sheet";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const store = useSeries();
  const nav = useSeriesNav();
  const [entries, setEntries] = useState<Entry[]>(() => initialEntries(subject, fixedSeriesId));
  const [active, setActive] = useState(0);
  const [alsoOpen, setAlsoOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<SeriesTarget | null>(null);
  const subjectKey = JSON.stringify(subject);

  // Fill in positions (#N) and, for images / queue tasks, the series list.
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (subject.kind === "record") {
        const { items } = await api.seriesPositions([subject.generationId]);
        const p = items[0];
        if (alive && p?.seriesId) {
          setEntries([
            { seriesId: p.seriesId, role: "output", seq: p.seq, generationId: subject.generationId, version: p.version },
          ]);
        }
      } else if (subject.kind === "image") {
        const list = subject.entries ?? (await fetchImageSeries(subject.imageId));
        if (alive) {
          const next = initialEntries({ ...subject, entries: list }, fixedSeriesId);
          if (next.length) setEntries(next);
        }
      } else if (subject.kind === "task" && subject.imageId) {
        const { generations } = await api.generationsByImage(subject.imageId);
        const own = generations.find((g) => g.role === "output" && g.client_task_id === subject.clientTaskId);
        if (alive && own?.series_id) {
          setEntries([{ seriesId: own.series_id, role: "output", seq: own.seq, generationId: own.id }]);
          const { items } = await api.seriesPositions([own.id]);
          const version = items[0]?.version ?? null;
          if (alive && version) {
            setEntries([{ seriesId: own.series_id, role: "output", seq: own.seq, generationId: own.id, version }]);
          }
        }
      }
    };
    run().catch(() => {});
    return () => {
      alive = false;
    };
  }, [subjectKey, fixedSeriesId]); // eslint-disable-line react-hooks/exhaustive-deps

  const entry = entries[Math.min(active, entries.length - 1)];

  // What Change / Remove act on, for the series shown.
  useEffect(() => {
    let alive = true;
    setTarget(null);
    if (!entry) return;
    const sid = entry.seriesId;
    if (subject.kind === "draft") {
      setTarget({ body: { draftIds: [subject.draftId] }, members: [sid] });
    } else if (subject.kind === "image") {
      // Only the records of *this* series that produced the image; a series
      // that merely used it as an input has nothing to move.
      if (entry.role !== "output") return;
      api
        .generationsByImage(subject.imageId)
        .then(({ generations }) => {
          const ids = generations.filter((g) => g.role === "output" && g.series_id === sid).map((g) => g.id);
          if (alive && ids.length) setTarget({ body: { generationIds: ids }, members: ids.map(() => sid) });
        })
        .catch(() => {});
    } else if (entry.generationId) {
      setTarget({ body: { generationIds: [entry.generationId] }, members: [sid] });
    }
    return () => {
      alive = false;
    };
  }, [entry?.seriesId, entry?.generationId, entry?.role, subjectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const node = store.node(entry?.seriesId);
  const path = store.get(entry?.seriesId);
  const others = useMemo(() => entries.filter((_, i) => i !== active), [entries, active]);
  if (!entry || !path || !node) return null;

  const rate = successRate(node);
  const position = entryPosition(entry, t);
  const multi = entries.length > 1;

  const remove = async () => {
    if (!target) return;
    const name = path.name;
    const sid = entry.seriesId;
    const body = target.body;
    onClose();
    try {
      await seriesApi.unassign(body);
      nav.onChanged();
      toast(t("sv2_removed_from", { series: name }), "info", {
        durationMs: 8000,
        action: {
          label: t("undo"),
          onClick: () => {
            seriesApi
              .assign(sid, body)
              .then(() => nav.onChanged())
              .catch((e) => toast(t("op_failed", { msg: (e as Error).message }), "error"));
          },
        },
      });
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  if (picking && target) {
    return (
      <div className={`sv2-card ${variant} picking`}>
        {actions.picker(target, onClose, true)}
      </div>
    );
  }

  const rows = (
    <div className="sv2-card-rows">
      <button type="button" className="sv2-card-row" onClick={() => { onClose(); nav.openInWorkspace(entry.seriesId); }}>
        <Icon name="workspace" size="sm" />
        <span>{t("series_open_in_workspace")}</span>
      </button>
      {target && (
        <>
          <button type="button" className="sv2-card-row" onClick={() => setPicking(true)}>
            <Icon name="changeSeries" size="sm" />
            <span>{t("sv2_change_series")}</span>
          </button>
          <button type="button" className="sv2-card-row danger" onClick={() => void remove()}>
            <Icon name="remove" size="sm" />
            <span>{t("series_remove_from")}</span>
          </button>
        </>
      )}
    </div>
  );

  const also = multi && (
    <div className={`sv2-card-also${alsoOpen ? " open" : ""}`}>
      <button
        type="button"
        className="sv2-card-also-head"
        aria-expanded={alsoOpen}
        onClick={() => setAlsoOpen((v) => !v)}
      >
        <Icon name={alsoOpen ? "chevronDown" : "next"} size="sm" />
        <span>{t("sv2_also_in", { n: others.length })}</span>
      </button>
      {alsoOpen &&
        others.map((o) => {
          const p = store.get(o.seriesId);
          if (!p) return null;
          return (
            <button
              key={o.seriesId}
              type="button"
              className="sv2-card-also-row"
              onClick={() => {
                setActive(entries.indexOf(o));
                setPicking(false);
              }}
            >
              <SeriesDot color={p.color} />
              <span className="sv2-card-also-theme">{p.theme ? `${p.theme.name} /` : `${t("series_no_theme")} /`}</span>
              <span className="sv2-card-also-name">{p.name}</span>
              <span className="sv2-card-also-pos">{entryPosition(o, t)}</span>
              <Icon name="next" size="sm" />
            </button>
          );
        })}
    </div>
  );

  return (
    <div className={`sv2-card ${variant}`} role="group" aria-label={t("sv2_card_label")}>
      <div className="sv2-card-path">
        <span className="sv2-card-theme">{path.theme ? `${path.theme.name} /` : `${t("series_no_theme")} /`}</span>
        <div className="sv2-card-title">
          {path.archived ? <Icon name="archive" size="sm" /> : <SeriesDot color={path.color} size="lg" />}
          <b title={path.name}>{path.name}</b>
          {multi && active === 0 && <span className="sv2-card-primary">{t("sv2_primary_latest")}</span>}
        </div>
      </div>
      <Collage node={node} size="info" />
      <div className="sv2-card-stats">
        <span>
          {rate === null
            ? t("sv2_stats_tries", { n: node.tries })
            : t("sv2_stats", { n: node.tries, p: rate })}
        </span>
        {multi && position && <span className="sv2-pos">{position}</span>}
      </div>
      {!multi && node.strip.length > 0 && <StatusStrip strip={node.strip} />}
      {!multi && position && (
        <div className="sv2-card-record">
          <span>{t("sv2_this_record")}</span>
          <span className="sv2-pos">{position}</span>
        </div>
      )}
      <button
        type="button"
        className="sv2-card-open"
        onClick={() => {
          onClose();
          nav.openSeries(entry.seriesId);
        }}
      >
        <Icon name="openSeries" size="sm" />
        {t("sv2_open_series")}
      </button>
      {variant === "popover" && also}
      {rows}
      {variant === "sheet" && also}
    </div>
  );
}
