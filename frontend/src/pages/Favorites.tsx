import { type CSSProperties, useEffect, useState } from "react";
import { api, Generation, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import SearchBox from "../components/SearchBox";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
const PROMPT_PREVIEW_CHARS = 160;
const PROMPT_PREVIEW_LINES = 3;
const FAV_COLUMNS_KEY = "imagen-fav-columns";
const FAV_COLUMN_OPTIONS = [1, 2, 3];
const FAV_COLUMN_OPTIONS_FULL = [2, 3, 4];

function initialFavColumns() {
  const saved = Number(localStorage.getItem(FAV_COLUMNS_KEY));
  return FAV_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
}

// Prompt-centric "favorites" view: the saved-prompt collection. A favorite is a
// starred generated image; this lists those generations note-first so long
// prompts are easy to tell apart, with copy / reuse / unfavorite.
export default function Favorites({
  onReuse,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  onChanged,
}: {
  onReuse: (g: Generation) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [gens, setGens] = useState<Generation[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [columns, setColumns] = useState(initialFavColumns);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

  const load = () => {
    setLoading(true);
    api
      .listGenerations({
        starred: true,
        limit: pageSize,
        offset: page * pageSize,
        q: query || undefined,
      })
      .then((r) => {
        setGens(r.generations);
        setTotal(r.total);
        // Seed editable note drafts from the output image's note.
        const seed: Record<number, string> = {};
        for (const g of r.generations) {
          if (g.outputImage) seed[g.outputImage.id] = g.outputImage.note ?? "";
        }
        setNotes(seed);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, pageSize, query, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(FAV_COLUMNS_KEY, String(columns));
  }, [columns]);

  const toggleExpand = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const saveNote = async (img: ImageRow) => {
    const draft = (notes[img.id] ?? "").trim();
    if (draft === (img.note ?? "")) return;
    await api.patchImage(img.id, { note: draft });
    img.note = draft;
    onChanged?.();
  };

  const unfavorite = async (img: ImageRow) => {
    await api.patchImage(img.id, { starred: false });
    load();
    onChanged?.();
  };

  const copyPrompt = async (g: Generation) => {
    try {
      await navigator.clipboard.writeText(g.prompt);
      setCopiedId(g.id);
      setTimeout(() => setCopiedId((c) => (c === g.id ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;
  const pageOutputs = gens
    .map((g) => g.outputImage)
    .filter((o): o is ImageRow => !!o);

  const pager = hasPages ? (
    <div className="pager">
      <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
        {t("prev_page")}
      </button>
      <span className="muted small">
        {t("page_status", { page: page + 1, pages: pageCount, total })}
      </span>
      <button
        disabled={page >= pageCount - 1 || loading}
        onClick={() => setPage((p) => p + 1)}
      >
        {t("next_page")}
      </button>
    </div>
  ) : null;

  return (
    <div>
      <div className="history-toolbar">
        <div className="history-toolbar-row">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
              setPage(0);
            }}
            placeholder={t("search_placeholder_history")}
          />
          <div className="seg density-seg history-cols-seg" title={t("columns_per_row")}>
            {(compact ? FAV_COLUMN_OPTIONS : FAV_COLUMN_OPTIONS_FULL).map((n) => (
              <button
                key={n}
                className={columns === n ? "on" : ""}
                onClick={() => setColumns(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
      {pager}

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : gens.length === 0 ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          {query ? (
            <div className="empty-state">
              <span>{t("no_results")}</span>
              <button
                onClick={() => {
                  setQuery("");
                  setPage(0);
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("favorites_empty")
          )}
        </div>
      ) : (
        <div
          className={`history-list${compact ? " compact" : ""}`}
          style={{ "--history-columns": columns } as CSSProperties}
        >
          {gens.map((g) => (
            <div className="panel history-panel fav-panel" key={g.id}>
              {g.outputImage && (
                <input
                  className="fav-note"
                  value={notes[g.outputImage.id] ?? ""}
                  placeholder={t("note_placeholder")}
                  onChange={(e) =>
                    setNotes((n) => ({
                      ...n,
                      [g.outputImage!.id]: e.target.value,
                    }))
                  }
                  onBlur={() => saveNote(g.outputImage!)}
                />
              )}
              <div className="history-meta">
                <span className="muted small">{g.model}</span>
                {g.aspect_ratio && (
                  <span className="muted small">· {g.aspect_ratio}</span>
                )}
                {g.resolution && (
                  <span className="muted small">· {g.resolution}</span>
                )}
                <div className="spacer" style={{ flex: 1 }} />
                <button className="link-btn" onClick={() => copyPrompt(g)}>
                  {copiedId === g.id ? t("copied") : t("copy_prompt")}
                </button>
                <button onClick={() => onReuse(g)}>{t("reuse")}</button>
                {g.outputImage && (
                  <button
                    className="star is-starred"
                    title={t("unfavorite")}
                    onClick={() => unfavorite(g.outputImage!)}
                  >
                    ★
                  </button>
                )}
              </div>

              {g.prompt && (
                <div className="history-prompt-wrap">
                  <p
                    className={`history-prompt${
                      expanded.has(g.id) ? " expanded" : ""
                    }`}
                  >
                    {g.prompt}
                  </p>
                  {(g.prompt.length > PROMPT_PREVIEW_CHARS ||
                    g.prompt.split(/\r?\n/).length > PROMPT_PREVIEW_LINES) && (
                    <button
                      className="link-btn history-prompt-toggle"
                      onClick={() => toggleExpand(g.id)}
                    >
                      {expanded.has(g.id) ? t("show_less") : t("show_more")}
                    </button>
                  )}
                </div>
              )}

              {/* input images + prompt together form the reusable "input" */}
              <div className="gen-row">
                <div className="gen-inputs">
                  {(g.inputs ?? []).map((im) =>
                    im.deleted_at ? (
                      <span
                        key={im.id}
                        className="deleted-tile"
                        title={t("deleted_label")}
                      >
                        <i className="fa-solid fa-trash-can" />
                      </span>
                    ) : (
                      <img
                        key={im.id}
                        src={imgThumbUrl(im.id)}
                        alt={im.filename}
                        title={im.filename}
                        onClick={() => onOpenViewer(im, g.inputs ?? [])}
                      />
                    ),
                  )}
                  {(g.inputs ?? []).length === 0 && (
                    <span className="muted small">{t("no_refs")}</span>
                  )}
                </div>
                <span className="arrow">→</span>
                <div className="gen-out">
                  {g.outputImage && (
                    <div>
                      <img
                        src={imgThumbUrl(g.outputImage.id)}
                        alt="output"
                        title={t("open_viewer")}
                        onClick={() => onOpenViewer(g.outputImage!, pageOutputs)}
                      />
                      {g.outputImage.tags && g.outputImage.tags.length > 0 && (
                        <div className="card-tags">
                          {g.outputImage.tags.map((tg) => (
                            <span key={tg.id} className="card-tag">
                              {tg.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pager}
    </div>
  );
}
