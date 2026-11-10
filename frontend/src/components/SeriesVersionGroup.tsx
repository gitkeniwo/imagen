import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ImageRow,
  imgThumbUrl,
  type ProviderId,
  type SeriesVersion,
  type SeriesVersionAttempt,
  type SeriesVersionParam,
} from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { cardTime, clockTime, dayKey, parseTime } from "../historyTime";
import { type DiffSegment, diffWords, splitTrailingSpace } from "../promptDiff";
import { useProviders } from "../useProviders";
import { useToast } from "./Toast";
import { IconButton } from "./ui/Button";
import Icon from "./ui/Icon";
import Menu, { type MenuItem } from "./ui/Menu";

// series-v2 B3: one version of the Changes view — consecutive attempts with
// the same configuration, its prompt shown once and diffed against the
// previous version of the full series order ("vs vN").

const STATUS_BAR_MAX = 12;
const PARAM_ORDER: SeriesVersionParam[] = ["model", "resolution", "aspect_ratio", "inputs"];
const PARAM_LABEL: Record<SeriesVersionParam, string> = {
  model: "sv2_param_model",
  resolution: "sv2_param_resolution",
  aspect_ratio: "sv2_param_ratio",
  inputs: "sv2_param_inputs",
};

/** Short model name as the attempts rows show it ("Pro"). */
export function useModelShort() {
  const { spec } = useProviders();
  return (provider: ProviderId | undefined, model: string | null) =>
    model
      ? (spec(provider ?? "vertex", model)?.label ?? model)
          .replace(/\s*\(.*\)$/, "")
          .replace(/^Nano Banana (?=\S)/, "")
      : "";
}

/** "Nov 8 13:28–14:15", "Nov 7 18:10 – Nov 8 09:02" or "Nov 8 13:15". */
function timeRange(attempts: SeriesVersionAttempt[], lang: Parameters<typeof clockTime>[1]): string {
  const times = attempts
    .map((a) => parseTime(a.created_at))
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime());
  if (!times.length) return "";
  const now = new Date();
  const first = times[0];
  const last = times[times.length - 1];
  const stamp = (d: Date) => `${cardTime(d, now, lang)} ${clockTime(d, lang)}`;
  if (first.getTime() === last.getTime()) return stamp(first);
  if (dayKey(first) === dayKey(last)) return `${stamp(first)}–${clockTime(last, lang)}`;
  return `${stamp(first)} – ${stamp(last)}`;
}

/** Number of separate changed runs in a diff. */
function changeCount(segs: DiffSegment[]): number {
  let n = 0;
  let inRun = false;
  for (const seg of segs) {
    if (seg.kind === "equal") inRun = false;
    else if (!inRun) {
      n++;
      inRun = true;
    }
  }
  return n;
}

/** Where each clause of `text` starts, before `end` (comma / period / … ). */
function clauseStarts(text: string, end: number): number[] {
  const out = [0];
  const re = /[,.;:，。；：、]\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[0].length;
    if (at >= end) break;
    out.push(at);
  }
  return out;
}

function Segments({ segs, from = 0, clauses }: { segs: DiffSegment[]; from?: number; clauses?: number[] }) {
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.kind === "equal") {
          if (i === 0 && clauses) {
            // Measuring pass: one span per clause of the leading text.
            return clauses.map((start, k) => (
              <span key={`c${k}`} data-clause={start}>
                {seg.text.slice(start, clauses[k + 1] ?? seg.text.length)}
              </span>
            ));
          }
          const text = i === 0 && from > 0 ? seg.text.slice(from) : seg.text;
          return (
            <span key={i}>
              {i === 0 && from > 0 && <span className="series-vg-cut">… </span>}
              {text}
            </span>
          );
        }
        const [body, tail] = splitTrailingSpace(seg.text);
        return (
          <span key={i}>
            {seg.kind === "insert" ? <ins>{body}</ins> : <del>{body}</del>}
            {tail}
          </span>
        );
      })}
    </>
  );
}

/** The version's prompt, clamped to `lines`. When the first change sits
 *  below the clamp, the collapsed text starts a clause before it ("… "), so
 *  the diff is visible without expanding. */
function VersionPrompt({
  base,
  baseTag,
  prompt,
  lines,
  tapToExpand,
}: {
  base: string | null;
  baseTag: ReactNode;
  prompt: string;
  lines: number;
  tapToExpand: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const segs = useMemo<DiffSegment[]>(
    () => (base === null ? [{ kind: "equal", text: prompt }] : diffWords(base, prompt)),
    [base, prompt],
  );
  const [expanded, setExpanded] = useState(false);
  // null = not measured yet for this text / width.
  const [fit, setFit] = useState<{ cut: number; overflow: boolean } | null>(null);
  const ref = useRef<HTMLParagraphElement>(null);
  const width = useRef(0);

  const head = segs[0]?.kind === "equal" ? segs[0].text : "";
  const hasChange = segs.some((s) => s.kind !== "equal");
  const clauses = useMemo(
    () => (hasChange && head ? clauseStarts(head, head.length) : undefined),
    [hasChange, head],
  );

  useLayoutEffect(() => setFit(null), [segs, lines]);

  useLayoutEffect(() => {
    const p = ref.current;
    if (!p) return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(p.getBoundingClientRect().width);
      if (Math.abs(w - width.current) > 1) {
        width.current = w;
        setFit(null);
      }
    });
    ro.observe(p);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const p = ref.current;
    if (!p || expanded || fit) return;
    const lineH = parseFloat(getComputedStyle(p).lineHeight) || 24;
    const limit = lines * lineH;
    const top = p.getBoundingClientRect().top;
    const overflow = p.scrollHeight > p.clientHeight + 1;
    const change = p.querySelector("ins, del");
    const changeTop = change ? change.getBoundingClientRect().top - top : 0;
    if (!change || !clauses || changeTop + lineH <= limit + 1) {
      setFit({ cut: 0, overflow });
      return;
    }
    // Earliest clause (at least one before the change's own) that still
    // leaves the change on a visible line once the text before it is cut.
    const spans = [...p.querySelectorAll<HTMLElement>("[data-clause]")];
    const own = spans.length - 1;
    let cut = 0;
    for (let k = 0; k < spans.length; k++) {
      const spanTop = spans[k].getBoundingClientRect().top - top;
      if (changeTop - spanTop <= limit - 2 * lineH && k <= Math.max(0, own - 1)) {
        cut = Number(spans[k].dataset.clause) || 0;
        break;
      }
    }
    if (!cut && own > 0) cut = Number(spans[own - 1].dataset.clause) || 0;
    setFit({ cut, overflow: true });
  }, [fit, expanded, lines, clauses]);

  const measuring = !expanded && !fit;
  const cut = !expanded && fit ? fit.cut : 0;
  const clamped = !expanded && (fit?.overflow ?? true);
  const changes = changeCount(segs);

  return (
    <div className="series-vg-promptbox">
      <p
        ref={ref}
        className={`series-vg-prompt${expanded ? "" : " clamp"}${tapToExpand && clamped ? " tappable" : ""}`}
        style={{ ["--vg-lines" as string]: lines }}
        onClick={tapToExpand && clamped ? () => setExpanded(true) : undefined}
      >
        {baseTag}
        {prompt ? (
          <Segments segs={segs} from={cut} clauses={measuring ? clauses : undefined} />
        ) : (
          <span className="muted">{t("series_no_prompt")}</span>
        )}
      </p>
      {(expanded || clamped) && prompt && (
        <div className="series-vg-promptlinks">
          {expanded ? (
            <>
              <button type="button" className="series-vg-link" onClick={() => setExpanded(false)}>
                {t("sv2_show_less")}
              </button>
              <button
                type="button"
                className="series-vg-link"
                onClick={async () => toast((await copyText(prompt)) ? t("copied") : t("copy_failed"))}
              >
                {t("sv2_copy_prompt")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="series-vg-link" onClick={() => setExpanded(true)}>
                {t("sv2_show_all_chars", { n: prompt.length })}
              </button>
              {changes >= 2 && <span className="series-vg-changes">{t("sv2_n_changes", { n: changes })}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function errorCode(a: SeriesVersionAttempt): string | null {
  const m = /\b([1-5]\d\d)\b/.exec(`${a.raw_finish ?? ""} ${a.error_message ?? ""}`);
  return m ? m[1] : null;
}

function StripTile({
  a,
  onOpen,
  reasonText,
}: {
  a: SeriesVersionAttempt;
  onOpen: (img: ImageRow) => void;
  reasonText: string;
}) {
  const { t } = useI18n();
  const out = a.outputImage && !a.outputImage.deleted_at ? a.outputImage : null;
  const num = <span className="series-vg-num">#{a.seq}</span>;
  if (out) {
    return (
      <button
        type="button"
        className="series-vg-thumb"
        title={t("open_viewer")}
        onClick={() => onOpen(out)}
      >
        <img src={imgThumbUrl(out)} alt="" loading="lazy" draggable={false} />
        {num}
      </button>
    );
  }
  if (a.status === "running") {
    return (
      <div className="series-vg-thumb fail running">
        <span className="spinner" />
        {num}
      </div>
    );
  }
  if (a.status === "success") {
    return (
      <div className="series-vg-thumb fail deleted" title={t("series_output_deleted")}>
        <Icon name="imageMissing" size="sm" />
        {num}
      </div>
    );
  }
  const blocked = a.status === "blocked";
  return (
    <div className={`series-vg-thumb fail ${blocked ? "blocked" : "error"}`} title={reasonText}>
      <Icon name={blocked ? "shield" : "warning"} size="sm" />
      <span className="series-vg-fail-label">
        {blocked ? t("status_blocked") : a.status === "aborted" ? t("status_aborted") : errorCode(a) ?? t("status_error")}
      </span>
      {num}
    </div>
  );
}

export function VersionGroup({
  v,
  compact,
  filtered,
  onOpen,
  reasonOf,
  menu,
  renderAttempts,
}: {
  v: SeriesVersion;
  compact: boolean;
  /** A status filter is on (header says "a of n shown"). */
  filtered: boolean;
  onOpen: (img: ImageRow) => void;
  reasonOf: (a: SeriesVersionAttempt) => string;
  menu: MenuItem[];
  /** The expanded rows (Attempts-view rows, newest first). */
  renderAttempts: () => ReactNode;
}) {
  const { t, lang } = useI18n();
  const modelShort = useModelShort();
  const [open, setOpen] = useState(false);
  const attempts = v.attempts;
  const provider = attempts[attempts.length - 1]?.provider;
  const ok = v.counts.success;
  const range = timeRange(attempts, lang);
  const bar = attempts.slice(-STATUS_BAR_MAX);

  const paramValue = (key: SeriesVersionParam, params: SeriesVersion["params"]) => {
    if (key === "model") {
      // "Flash → Pro": the family word, as the design writes it.
      const id = params.model ?? "";
      return /flash/i.test(id) ? "Flash" : /pro/i.test(id) ? "Pro" : modelShort(provider, id);
    }
    if (key === "inputs") return String(params.input_ids.length);
    return params[key] ?? "";
  };
  const chips = v.base_params
    ? PARAM_ORDER.filter((k) => v.changed_params.includes(k)).map((k) => {
        const before = paramValue(k, v.base_params!);
        const after = paramValue(k, v.params);
        const label = t(PARAM_LABEL[k]);
        const text =
          k === "inputs" && before === after
            ? label
            : !before
              ? k === "resolution"
                ? after
                : `${label} ${after}`
              : `${label} ${before} → ${after || "—"}`;
        return <span key={k} className="series-vg-chip">{text}</span>;
      })
    : [];

  const baseTag =
    v.base_version !== null ? (
      <span className="series-vg-base">
        {t("sv2_vs_version", { k: v.base_version })}
        {v.base_hidden && <span className="series-vg-base-hidden">{t("sv2_hidden")}</span>}
      </span>
    ) : null;

  const tries = filtered
    ? t("sv2_a_of_n_shown", { a: v.attempts_total, n: v.counts.all })
    : t("series_tries_n", { n: v.counts.all });

  return (
    <li className={`series-vg${compact ? " compact" : ""}`} data-version={v.version}>
      <div className="series-vg-head">
        <span className="series-vg-pill">{t("sv2_version_n", { k: v.version })}</span>
        <strong>{tries}</strong>
        {!filtered && <span>· {t("sv2_ok_n", { n: ok })}</span>}
        {!filtered && bar.length > 0 && (
          <span className="series-vg-bar" aria-hidden="true">
            {bar.map((a) => (
              <i key={a.id} className={a.status} />
            ))}
          </span>
        )}
        {!filtered && !compact && range && <span>{range}</span>}
        <span className="spacer" />
        {v.base_version === null && <span className="series-vg-first">{t("sv2_first_version")}</span>}
        {menu.length > 0 && (
          <Menu
            className="series-vg-more"
            items={menu}
            renderTrigger={({ open: menuOpen, toggle }) => (
              <IconButton icon="more" size="sm" label={t("more_actions")} aria-expanded={menuOpen} onClick={toggle} />
            )}
          />
        )}
      </div>
      {!filtered && compact && range && <div className="series-vg-when">{range}</div>}
      {chips.length > 0 && <div className="series-vg-chips">{chips}</div>}
      {v.base_version !== null && !v.prompt_changed ? (
        <p className="series-vg-prompt unchanged">
          {baseTag}
          {t("sv2_prompt_unchanged")}
        </p>
      ) : (
        <VersionPrompt
          base={v.base_version !== null ? v.base_prompt ?? "" : null}
          baseTag={baseTag}
          prompt={v.prompt}
          lines={compact ? 3 : 4}
          tapToExpand={compact}
        />
      )}
      {attempts.length > 0 && (
        <div className="series-vg-strip">
          {attempts.map((a) => (
            <StripTile key={a.id} a={a} onOpen={onOpen} reasonText={reasonOf(a)} />
          ))}
        </div>
      )}
      {attempts.length > 1 && (
        <button
          type="button"
          className={`series-vg-toggle${open ? " open" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? "chevronUp" : "chevronDown"} size="sm" />
          {open ? t("sv2_hide_attempts") : t("sv2_n_attempts", { n: attempts.length })}
        </button>
      )}
      {open && attempts.length > 1 && <div className="series-vg-rows">{renderAttempts()}</div>}
    </li>
  );
}

/** A version whose attempts the filter hides completely. */
export function HiddenVersionRow({ v }: { v: SeriesVersion }) {
  const { t } = useI18n();
  return (
    <li className="series-vg-hidden" data-version={v.version}>
      <Icon name="view" size="sm" />
      <span>{t("sv2_version_hidden", { k: v.version, n: v.counts.all })}</span>
    </li>
  );
}

/** Placeholder group while the next versions load. */
export function VersionSkeleton() {
  return (
    <li className="series-vg-skeleton" aria-hidden="true">
      <div className="row">
        <i style={{ width: 28, height: 20 }} />
        <i style={{ width: 120 }} />
      </div>
      <i style={{ width: "92%" }} />
      <i style={{ width: "70%" }} />
      <div className="row">
        <i className="tile" />
        <i className="tile" />
      </div>
    </li>
  );
}
