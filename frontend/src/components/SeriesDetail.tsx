import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type HistoryResult,
  type ImageRow,
  imgThumbUrl,
  providerOf,
  type SeriesDetail as SeriesDetailRow,
  type SeriesGeneration,
  seriesApi,
} from "../api";
import { useI18n } from "../i18n";
import { cardTime, clockTime, dayKey, fullTime, parseTime } from "../historyTime";
import { generationRuntime } from "../generationMetrics";
import { changedParams, compactEqual, diffWords, type ParamKey, samePrompt, splitTrailingSpace } from "../promptDiff";
import { useProviders } from "../useProviders";
import { useSeries } from "../seriesStore";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Switch } from "./ComposerControls";
import { SeriesDot, successRate } from "./SeriesBits";
import { MoveToThemeDialog, SeriesEditDialog } from "./SeriesDialogs";
import { Button, IconButton } from "./ui/Button";
import Icon from "./ui/Icon";
import Menu, { type MenuItem } from "./ui/Menu";
import Segmented from "./ui/Segmented";

const PAGE = 30;
const FILM_HEIGHT = 96;
const BEST_HEIGHT = 180;
const OUTPUT_WIDTH = 88;

const ratioOf = (img: Pick<ImageRow, "width" | "height">) =>
  img.width > 0 && img.height > 0 ? img.width / img.height : 1;

export default function SeriesDetail({
  id,
  onBack,
  phone = false,
  refreshKey = 0,
  boundTo = [],
  onOpenViewer,
  onReuse,
  onRerun,
  onOpenInWorkspace,
}: {
  id: number;
  onBack: () => void;
  phone?: boolean;
  refreshKey?: number;
  /** Workspace numbers bound to this series. */
  boundTo?: number[];
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onReuse: (g: SeriesGeneration) => void;
  onRerun?: (g: SeriesGeneration) => void;
  onOpenInWorkspace: (id: number) => void;
}) {
  const { t, lang, reason } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const store = useSeries();
  const { isReady } = useProviders();
  const [detail, setDetail] = useState<SeriesDetailRow | null>(null);
  const [rows, setRows] = useState<SeriesGeneration[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, success: 0, blocked: 0, error: 0 });
  const [filter, setFilter] = useState<HistoryResult | "all">("all");
  const [showChanges, setShowChanges] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"rename" | "move" | null>(null);

  const load = useCallback(
    async (append = false) => {
      if (!append) setLoading(true);
      setError(null);
      try {
        const [d, tl] = await Promise.all([
          append ? Promise.resolve(null) : seriesApi.get(id),
          seriesApi.timeline(id, {
            status: filter === "all" ? undefined : filter,
            limit: PAGE,
            offset: append ? rows.length : 0,
          }),
        ]);
        if (d) setDetail(d);
        setRows((current) => (append ? [...current, ...tl.generations] : tl.generations));
        setTotal(tl.total);
        setCounts(tl.counts);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    // rows.length only matters for "load more"; a filter change restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, filter, rows.length],
  );

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, filter, refreshKey, store.version]);

  const setBest = async (imageId: number | null) => {
    try {
      await seriesApi.update(id, { bestImageId: imageId });
      await store.reload();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const archive = async (archived: boolean) => {
    try {
      await seriesApi.update(id, { archived });
      await store.reload();
      toast(archived ? t("series_archived_toast") : t("series_unarchived_toast"));
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const remove = async () => {
    if (!detail) return;
    const ok = await askConfirm({
      title: t("series_delete_title"),
      message: t("series_delete_message", { name: detail.name, n: detail.records }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await seriesApi.remove(id);
      await store.reload();
      onBack();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const outputs = useMemo(() => (detail?.outputs ?? []).map((o) => o.image), [detail]);
  const bestId = detail?.best_image?.id ?? null;
  const best = detail?.best_image ?? outputs[outputs.length - 1] ?? null;
  const bestSeq = useMemo(() => {
    if (!detail?.best_image) return null;
    return rows.find((r) => r.output_image_id === detail.best_image?.id)?.seq ?? null;
  }, [detail, rows]);

  if (!detail) {
    return (
      <div className="series-detail">
        <div className="panel muted">
          {error ? (
            <div className="load-error">
              <span className="small">{t("load_error", { msg: error })}</span>
              <button onClick={() => void load(false)}>{t("retry")}</button>
            </div>
          ) : (
            <>
              <span className="spinner" /> {t("loading")}
            </>
          )}
        </div>
      </div>
    );
  }

  const first = rows.length ? parseTime(rows[rows.length - 1].created_at) : null;
  const now = new Date();
  const spanFrom = detail.records > 0 && filter === "all" && rows.length === total && first ? first : null;
  const last = parseTime(detail.last_at);
  const rate = successRate(detail);
  const statLine = [
    t("series_tries_n", { n: detail.tries }),
    t("series_success_n", { n: detail.success }),
    t("series_blocked_n", { n: detail.blocked }),
    t("series_error_n", { n: detail.error }),
    detail.aborted > 0 ? t("series_cancelled_n", { n: detail.aborted }) : null,
    rate !== null && phone ? t("series_rate", { n: rate }) : null,
    last
      ? spanFrom && dayKey(spanFrom) !== dayKey(last)
        ? `${cardTime(spanFrom, now, lang)} – ${cardTime(last, now, lang)}`
        : cardTime(last, now, lang)
      : null,
    boundTo.length ? t("series_bound_to", { n: boundTo.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const moreItems: MenuItem[] = [
    ...(phone
      ? [
          { label: t("series_open_in_workspace"), icon: "reuse" as const, onSelect: () => onOpenInWorkspace(id) },
          { label: t("series_rename"), icon: "edit" as const, onSelect: () => setDialog("rename") },
          { label: t("series_move_to_theme"), icon: "moveToTheme" as const, onSelect: () => setDialog("move") },
        ]
      : []),
    detail.archived
      ? { label: t("series_unarchive"), icon: "unarchive", onSelect: () => void archive(false) }
      : { label: t("series_archive"), icon: "archive", onSelect: () => void archive(true) },
    ...(bestId ? [{ label: t("series_clear_best"), icon: "best" as const, onSelect: () => void setBest(null) }] : []),
    { label: t("series_delete"), icon: "delete", danger: true, onSelect: () => void remove() },
  ];

  const filterOptions = [
    { value: "all" as const, label: `${t("filter_all")} ${counts.all}` },
    { value: "success" as const, label: `${t("hist_result_success")} ${counts.success}` },
    { value: "blocked" as const, label: `${t("hist_result_blocked")} ${counts.blocked}` },
    { value: "error" as const, label: `${t("hist_result_error")} ${counts.error}` },
  ];

  return (
    <div className={`series-detail${phone ? " phone" : ""}`}>
      <header className="series-detail-head">
        {phone ? (
          <div className="series-detail-phonebar">
            <IconButton icon="prev" label={t("series_back")} onClick={onBack} />
            <SeriesDot color={detail.color} />
            <div className="series-detail-phonetitle">
              <span>{detail.theme?.name ?? t("series_no_theme")}</span>
              <h2>{detail.name}</h2>
            </div>
            <Menu
              items={moreItems}
              renderTrigger={({ open, toggle }) => (
                <IconButton icon="more" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
              )}
            />
          </div>
        ) : (
          <>
            <nav className="series-crumbs" aria-label={t("series_breadcrumb")}>
              <button type="button" onClick={onBack}>{t("tab_series")}</button>
              <span aria-hidden="true">/</span>
              <span>{detail.theme?.name ?? t("series_no_theme")}</span>
            </nav>
            <div className="series-detail-title">
              <SeriesDot color={detail.color} size="lg" />
              <h2>{detail.name}</h2>
              {!!detail.archived && <span className="series-archived-flag">{t("series_archived")}</span>}
              <div className="series-detail-actions">
                <Button size="sm" onClick={() => onOpenInWorkspace(id)}>{t("series_open_in_workspace")}</Button>
                <Button size="sm" onClick={() => setDialog("rename")}>{t("series_rename")}</Button>
                <Button size="sm" onClick={() => setDialog("move")}>{t("series_move_to_theme")}…</Button>
                <Menu
                  items={moreItems}
                  renderTrigger={({ open, toggle }) => (
                    <IconButton icon="more" variant="outline" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
                  )}
                />
              </div>
            </div>
          </>
        )}
        <p className="series-detail-stats">{statLine}</p>
      </header>

      {outputs.length > 0 && best && (
        <section className="series-outputs" aria-label={t("series_outputs")}>
          <figure className="series-best">
            <button
              type="button"
              className="series-best-img"
              style={{ height: phone ? 64 : BEST_HEIGHT, width: (phone ? 64 : BEST_HEIGHT) * ratioOf(best) }}
              onClick={() => onOpenViewer(best, outputs)}
              title={t("open_viewer")}
            >
              <img src={imgThumbUrl(best)} alt="" draggable={false} />
            </button>
            {!phone && (
              <figcaption>
                {bestId ? (bestSeq ? t("series_best_n", { n: bestSeq }) : t("series_best")) : t("series_latest")}
              </figcaption>
            )}
          </figure>
          {!phone && (
            <div className="series-film-wrap">
              <div className="series-film">
                {outputs.map((img) => (
                  <button
                    key={img.id}
                    type="button"
                    className={`series-film-item${img.id === bestId ? " best" : ""}`}
                    style={{ height: FILM_HEIGHT, width: Math.round(FILM_HEIGHT * ratioOf(img)) }}
                    title={t("open_viewer")}
                    onClick={() => onOpenViewer(img, outputs)}
                  >
                    <img src={imgThumbUrl(img)} alt="" loading="lazy" draggable={false} />
                  </button>
                ))}
              </div>
              <span className="series-film-caption">{t("series_all_outputs", { n: outputs.length })}</span>
            </div>
          )}
        </section>
      )}

      <div className="series-timeline-bar">
        {phone ? (
          <div className="series-filter-chips" role="group" aria-label={t("hist_filter_result")}>
            {filterOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`tag-chip${filter === o.value ? " on" : ""}`}
                aria-pressed={filter === o.value}
                onClick={() => setFilter(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <Segmented value={filter} onChange={setFilter} options={filterOptions} />
        )}
        <div className="spacer" />
        <Switch checked={showChanges} onChange={setShowChanges} label={t("series_show_changes")} />
        {!phone && <span className="series-order">{t("series_newest_first")}</span>}
      </div>

      {loading && rows.length === 0 ? (
        <div className="panel muted"><span className="spinner" /> {t("loading")}</div>
      ) : rows.length === 0 ? (
        <div className="series-empty">{detail.records === 0 ? t("series_detail_empty") : t("no_results")}</div>
      ) : (
        <ol className="series-timeline" aria-label={t("series_attempts")}>
          {rows.map((g) => (
            <TimelineRow
              key={g.id}
              g={g}
              phone={phone}
              showChanges={showChanges}
              isBest={!!g.output_image_id && g.output_image_id === bestId}
              onOpen={(img) => onOpenViewer(img, outputs.length ? outputs : [img])}
              onReuse={() => onReuse(g)}
              onRerun={onRerun && g.source !== "manual" && isReady(providerOf(g)) ? () => onRerun(g) : undefined}
              onSetBest={g.outputImage && !g.outputImage.deleted_at ? () => void setBest(g.outputImage!.id) : undefined}
              reasonText={reason(g.raw_finish, providerOf(g)) || g.error_message || t("no_output")}
              timeText={(() => {
                const d = parseTime(g.created_at);
                if (!d) return "";
                return dayKey(d) === dayKey(now) ? clockTime(d, lang) : `${cardTime(d, now, lang)} ${clockTime(d, lang)}`;
              })()}
              fullTimeText={(() => {
                const d = parseTime(g.created_at);
                return d ? fullTime(d, lang) : "";
              })()}
            />
          ))}
        </ol>
      )}
      {rows.length < total && (
        <div className="series-more">
          <Button onClick={() => void load(true)} disabled={loading}>
            {t("series_load_more", { n: total - rows.length })}
          </Button>
        </div>
      )}

      {dialog === "rename" && (
        <SeriesEditDialog
          mode="edit"
          id={id}
          initialName={detail.name}
          initialColor={detail.color}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "move" && (
        <MoveToThemeDialog id={id} current={detail.parent_id} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

const PARAM_ORDER: ParamKey[] = ["provider", "model", "resolution", "aspect_ratio", "inputs"];

function TimelineRow({
  g,
  phone,
  showChanges,
  isBest,
  onOpen,
  onReuse,
  onRerun,
  onSetBest,
  reasonText,
  timeText,
  fullTimeText,
}: {
  g: SeriesGeneration;
  phone: boolean;
  showChanges: boolean;
  isBest: boolean;
  onOpen: (img: ImageRow) => void;
  onReuse: () => void;
  onRerun?: () => void;
  onSetBest?: () => void;
  reasonText: string;
  timeText: string;
  fullTimeText: string;
}) {
  const { t } = useI18n();
  const { spec } = useProviders();
  const status = g.status === "aborted" ? "aborted" : g.status;
  const output = g.outputImage && !g.outputImage.deleted_at ? g.outputImage : null;
  const inputs = g.inputs ?? [];
  const runtime = generationRuntime(g.duration_ms, g.attempts, t);
  const prev = g.previous;
  const same = !!prev && samePrompt(prev.prompt, g.prompt);
  const changed = showChanges
    ? changedParams(prev, {
        provider: providerOf(g),
        model: g.model,
        aspect_ratio: g.aspect_ratio,
        resolution: g.resolution,
        input_ids: inputs.map((im) => im.id),
      })
    : new Set<ParamKey>();
  const modelLabel = (spec(providerOf(g), g.model)?.label ?? g.model)
    .replace(/\s*\(.*\)$/, "")
    .replace(/^Nano Banana (?=\S)/, "");
  const paramText: Record<ParamKey, string | null> = {
    provider: t(`provider_short_${providerOf(g)}`),
    model: modelLabel,
    resolution: g.resolution,
    aspect_ratio: g.aspect_ratio,
    inputs: null,
  };
  const params = PARAM_ORDER.filter((k) => paramText[k]);

  const actions: MenuItem[] = [
    { label: t("reuse"), icon: "reuse", onSelect: onReuse },
    ...(onRerun ? [{ label: t("rerun_short"), icon: "rerun" as const, onSelect: onRerun }] : []),
    ...(onSetBest && !isBest ? [{ label: t("series_set_best"), icon: "best" as const, onSelect: onSetBest }] : []),
  ];

  const prompt =
    showChanges && same ? (
      <p className="series-same">{t("series_same_prompt", { n: prev!.seq })}</p>
    ) : showChanges && prev ? (
      <p className="series-prompt">
        {(phone ? compactEqual(diffWords(prev.prompt, g.prompt)) : diffWords(prev.prompt, g.prompt)).map((seg, i) => {
          if (seg.kind === "equal") return <span key={i}>{seg.text}</span>;
          const [body, tail] = splitTrailingSpace(seg.text);
          return (
            <span key={i}>
              {seg.kind === "insert" ? <ins>{body}</ins> : <del>{body}</del>}
              {tail}
            </span>
          );
        })}
      </p>
    ) : (
      <p className="series-prompt">{g.prompt || <span className="muted">{t("series_no_prompt")}</span>}</p>
    );

  const media = output ? (
    <button
      type="button"
      className={`series-row-output${isBest ? " best" : ""}`}
      style={{ aspectRatio: `${output.width} / ${output.height}` }}
      onClick={() => onOpen(output)}
      title={t("open_viewer")}
    >
      <img src={imgThumbUrl(output)} alt="" loading="lazy" draggable={false} />
    </button>
  ) : g.status === "running" ? (
    <div className="series-row-fail running"><span className="spinner" /></div>
  ) : (
    <div className={`series-row-fail ${status === "blocked" ? "blocked" : "error"}`} title={reasonText}>
      {g.outputImage?.deleted_at || (g.status === "success" && !g.outputImage) ? t("deleted_label") : reasonText}
    </div>
  );

  return (
    <li className={`series-row${phone ? " phone" : ""}`}>
      <span className="series-row-n">#{g.seq}</span>
      {!phone && (
        <span className="series-row-rail" aria-hidden="true">
          <i className={status} />
        </span>
      )}
      <div className="series-row-body">
        <div className="series-row-meta">
          {phone && <i className={`series-row-dot ${status}`} aria-hidden="true" />}
          {phone && <span className="series-row-n-inline">#{g.seq}</span>}
          <strong className={`series-status ${status}`}>{t(`status_${status}`)}</strong>
          <time dateTime={g.created_at} title={fullTimeText}>{timeText}</time>
          {!phone && runtime && <span>· {runtime}</span>}
          {!phone && (
            <span className="series-params">
              ·{" "}
              {params.map((k, i) => (
                <span key={k}>
                  <span className={changed.has(k) ? "changed" : undefined}>{paramText[k]}</span>
                  {i < params.length - 1 ? " · " : ""}
                </span>
              ))}
            </span>
          )}
          {isBest && <span className="series-best-flag">{t("series_best")}</span>}
          {phone ? (
            <Menu
              className="series-row-more"
              items={actions}
              renderTrigger={({ open, toggle }) => (
                <IconButton icon="more" size="sm" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
              )}
            />
          ) : (
            <span className="series-row-actions">
              {actions.map((a) => (
                <button key={a.label} type="button" className="series-ghost" onClick={a.onSelect}>
                  {a.label}
                </button>
              ))}
            </span>
          )}
        </div>
        {prompt}
        {inputs.length > 0 && (
          <div className={`series-row-inputs${changed.has("inputs") ? " changed" : ""}`}>
            {inputs.slice(0, 4).map((im) =>
              im.deleted_at ? (
                <span key={im.id} className="deleted-tile"><Icon name="imageMissing" size="sm" /></span>
              ) : (
                <img key={im.id} src={imgThumbUrl(im)} alt="" loading="lazy" onClick={() => onOpen(im)} />
              ),
            )}
            <span>{t("inputs_n", { n: inputs.length })}</span>
          </div>
        )}
      </div>
      <div className="series-row-media" style={{ width: phone ? 72 : OUTPUT_WIDTH }}>{media}</div>
    </li>
  );
}
