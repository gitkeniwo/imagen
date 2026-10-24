import { type CSSProperties, useEffect, useState } from "react";
import { api, Generation, ImageRow, Tag } from "../api";
import { useI18n } from "../i18n";
import AddHistoryModal from "../components/AddHistoryModal";
import { pageSizedToColumns } from "../pageSize";
import SearchBox from "../components/SearchBox";
import TagFilterRow from "../components/TagFilterRow";
import { useToast } from "../components/Toast";
import { useRemote } from "../remote";
import { RemoteChip } from "../components/RemoteIndicator";
import Icon from "../components/ui/Icon";
import appIcon from "../assets/app-icon.png";
import HistoryItem, { type HistoryLayout } from "../components/HistoryItem";
import { Button } from "../components/ui/Button";
import Segmented from "../components/ui/Segmented";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
const HISTORY_COLUMNS_KEY = "imagen-history-columns";
const HISTORY_COLUMN_OPTIONS = [1, 2, 3];
const HISTORY_COLUMN_OPTIONS_FULL = [1, 2, 3, 4, 5];
const HISTORY_LAYOUT_KEY = "imagen-history-layout";

function initialHistoryLayout(): HistoryLayout {
  return localStorage.getItem(HISTORY_LAYOUT_KEY) === "list" ? "list" : "grid";
}

function initialHistoryColumns() {
  const saved = Number(localStorage.getItem(HISTORY_COLUMNS_KEY));
  return HISTORY_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
}

export default function History({
  onReuse,
  onRerun,
  onUseAsRef,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  live = false,
  phone = false,
}: {
  onReuse: (g: Generation) => void;
  onRerun?: (g: Generation) => void;
  onUseAsRef?: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
  live?: boolean;
  phone?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { remote } = useRemote();
  const [gens, setGens] = useState<Generation[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<"vertex" | "manual" | null>(null);
  const [onlyWithImage, setOnlyWithImage] = useState(false);
  const [query, setQuery] = useState("");
  const [editingGen, setEditingGen] = useState<Generation | null>(null);
  const [duplicatingGen, setDuplicatingGen] = useState<Generation | null>(null);
  const [columns, setColumns] = useState(initialHistoryColumns);
  const [layout, setLayout] = useState(initialHistoryLayout);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Enter grid rows per page, never a ragged last row; list view has one item
  // per row, so it keeps the plain target size. The phone grid is two columns.
  const effectiveColumns = phone ? 2 : columns;
  const pageSize = pageSizedToColumns(
    compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE,
    layout === "list" ? 1 : effectiveColumns,
  );

  const load = (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setLoadError(null);
    }
    Promise.all([
      api.listGenerations({
        limit: pageSize,
        offset: page * pageSize,
        tag: tagFilter ?? undefined,
        q: query || undefined,
        kind: kindFilter ?? undefined,
        withOutput: onlyWithImage,
      }),
      api.listTags(),
    ])
      .then(([r, tagsRes]) => {
        setGens(r.generations);
        setTotal(r.total);
        setTags(tagsRes.tags);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .catch((e) => {
        // A background refresh should never replace the current card with a
        // flashing error state. The next normal refresh can surface an error.
        if (!quiet) setLoadError((e as Error).message);
      })
      .finally(() => {
        if (!quiet) setLoading(false);
      });
  };

  useEffect(load, [page, pageSize, tagFilter, kindFilter, onlyWithImage, query, refreshKey]);

  // While a request is in flight, poll only when History is actually mounted.
  // This makes the backend-created `running` placeholder appear without
  // refreshing Library or the rest of the workspace.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => load(true), 3000);
    return () => window.clearInterval(id);
  }, [live, page, pageSize, tagFilter, kindFilter, onlyWithImage, query]);

  const toggleStar = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: !img.starred });
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  useEffect(() => {
    localStorage.setItem(HISTORY_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(HISTORY_LAYOUT_KEY, layout);
  }, [layout]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  // All output images on this page, for viewer prev/next navigation.
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

  // Phone keeps a single compact pager above the list (the bottom copy is
  // hidden), matching the library island's ‹ 1/3 › + total row.
  const phonePager = (
    <div className="phone-pager-row">
      <div className="phone-pg">
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("prev_page")}
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <Icon name="prev" size="sm" />
          </button>
        )}
        <span>
          {hasPages
            ? t("phone_page_status", { page: page + 1, pages: pageCount })
            : t("phone_total_images", { n: total })}
        </span>
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("next_page")}
            disabled={page >= pageCount - 1 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <Icon name="next" size="sm" />
          </button>
        )}
      </div>
      {hasPages && <span className="phone-pager-total">{t("phone_total_images", { n: total })}</span>}
    </div>
  );

  const tagBar = (
    <TagFilterRow
      tags={tags}
      value={tagFilter}
      onChange={(id) => {
        setTagFilter(id);
        setPage(0);
      }}
    />
  );

  // Collect unique tags from all images in a generation (inputs + output).
  const genTags = (g: Generation) => {
    const all = [...(g.inputs ?? []), ...(g.outputImage ? [g.outputImage] : [])];
    const seen = new Set<number>();
    return all.flatMap((im) => im.tags ?? []).filter((tg) => {
      if (seen.has(tg.id)) return false;
      seen.add(tg.id);
      return true;
    });
  };

  return (
    <div className={phone ? "history-phone" : undefined}>
      {phone && (
        <div className="phone-head">
          <img className="phone-logo" src={appIcon} alt="" />
          <h1>
            {t("tab_history")} <span>{total}</span>
          </h1>
          {remote && <RemoteChip />}
        </div>
      )}
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
          {layout === "grid" && !phone && (
          <ViewPopover>
            <PopoverSection label={t("columns_per_row")}>
              <Segmented
                dense
                value={columns}
                onChange={(n) => {
                  setColumns(n);
                  setPage(0);
                }}
                options={(compact ? HISTORY_COLUMN_OPTIONS : HISTORY_COLUMN_OPTIONS_FULL).map((n) => ({
                  value: n,
                  label: String(n),
                }))}
              />
            </PopoverSection>
          </ViewPopover>
          )}
          <Segmented
            className="view-seg"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "grid", label: t("view_grid"), icon: "columns", iconOnly: true, title: t("view_grid") },
              { value: "list", label: t("view_list"), icon: "listView", iconOnly: true, title: t("view_list") },
            ]}
          />
        </div>
        <div className={`filter-row${phone ? " phone-filter-row" : ""}`}>
          <Segmented
            value={kindFilter ?? "all"}
            onChange={(v) => {
              setKindFilter(v === "all" ? null : v);
              setPage(0);
            }}
            options={[
              { value: "all", label: t("filter_all") },
              { value: "vertex", label: t("hist_filter_vertex"), icon: "generated", iconOnly: phone, title: t("hist_filter_vertex") },
              { value: "manual", label: t("hist_filter_manual"), icon: "imported", iconOnly: phone, title: t("hist_filter_manual") },
            ]}
          />
          <Button
            className={`skip-toggle${onlyWithImage ? " on" : ""}`}
            icon="library"
            title={t("hist_filter_with_image")}
            aria-label={t("hist_filter_with_image")}
            aria-pressed={onlyWithImage}
            onClick={() => {
              setOnlyWithImage((value) => !value);
              setPage(0);
            }}
          >
            <span className="filter-label">{t("hist_filter_with_image")}</span>
          </Button>
        </div>
        {tagBar}
      </div>
      {phone ? phonePager : pager}

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : loadError ? (
        <div className={`panel history-panel${compact ? " compact" : ""}`}>
          <div className="load-error">
            <span className="small">{t("load_error", { msg: loadError })}</span>
            <button onClick={() => load()}>{t("retry")}</button>
          </div>
        </div>
      ) : gens.length === 0 ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          {query || tagFilter !== null || kindFilter !== null || onlyWithImage ? (
            <div className="empty-state">
              <span>{t("no_results")}</span>
              <button
                onClick={() => {
                  setQuery("");
                  setTagFilter(null);
                  setKindFilter(null);
                  setOnlyWithImage(false);
                  setPage(0);
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("history_empty")
          )}
        </div>
      ) : (
        <div
          className={`history-list hlist ${layout}${compact ? " compact" : ""}${phone && layout === "grid" ? " phone-cols2" : ""}`}
          style={layout === "grid" ? ({ "--history-columns": effectiveColumns } as CSSProperties) : undefined}
        >
          {gens.map((g) => {
            const outImg = g.outputImage && !g.outputImage.deleted_at ? g.outputImage : null;
            const missing = !!g.outputImage?.deleted_at || (g.status === "success" && !g.outputImage);
            return (
              <HistoryItem
                key={g.id}
                g={g}
                layout={layout}
                output={outImg}
                missing={missing}
                onOpen={() => outImg && onOpenViewer(outImg, pageOutputs)}
                onToggleStar={outImg ? () => toggleStar(outImg) : undefined}
                onOpenInput={(im) => onOpenViewer(im, g.inputs ?? [])}
                tags={genTags(g)}
                onReuse={() => onReuse(g)}
                onRerun={onRerun ? () => onRerun(g) : undefined}
                onUseAsRef={onUseAsRef && outImg ? () => onUseAsRef(outImg) : undefined}
                onEdit={() => setEditingGen(g)}
                onDuplicate={() => setDuplicatingGen(g)}
              />
            );
          })}
        </div>
      )}

      {!phone && pager}

      {editingGen && (
        <AddHistoryModal
          existing={editingGen}
          onClose={() => setEditingGen(null)}
          onSaved={() => {
            setEditingGen(null);
            load();
          }}
        />
      )}
      {duplicatingGen && (
        <AddHistoryModal
          duplicate={duplicatingGen}
          onClose={() => setDuplicatingGen(null)}
          onSaved={() => {
            setDuplicatingGen(null);
            load();
          }}
        />
      )}
    </div>
  );
}
