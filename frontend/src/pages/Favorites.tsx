import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, Generation, ImageRow, providerOf } from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import AddHistoryModal from "../components/AddHistoryModal";
import { pageSizedToColumns } from "../pageSize";
import { useFitColumns } from "../useFitColumns";
import SearchBox from "../components/SearchBox";
import { useToast } from "../components/Toast";
import { copyText } from "../clipboard";
import Icon from "../components/ui/Icon";
import HistoryItem from "../components/HistoryItem";
import { downloadImage } from "../components/GenerationCard";
import Segmented from "../components/ui/Segmented";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import {
  type ContextMenuSection,
  type ContextMenuShortcut,
  useContextMenu,
} from "../components/ui/ContextMenu";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
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
  onRerun,
  onUseAsRef,
  trayIds = [],
  onRemoveFromTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  onChanged,
  phone = false,
}: {
  onReuse: (g: Generation) => void;
  onRerun?: (g: Generation) => void;
  onUseAsRef?: (img: ImageRow) => void;
  trayIds?: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  compact?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
  phone?: boolean;
}) {
  const { t } = useI18n();
  const { isReady } = useProviders();
  const toast = useToast();
  const { open: openContextMenu } = useContextMenu();
  const [gens, setGens] = useState<Generation[]>([]);
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [columns, setColumns] = useState(initialFavColumns);
  const [editingGen, setEditingGen] = useState<Generation | null>(null);
  const [duplicatingGen, setDuplicatingGen] = useState<Generation | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Fewer columns while cards would be too narrow for their buttons.
  const rootRef = useRef<HTMLDivElement>(null);
  const fitColumns = useFitColumns(rootRef, columns);
  const pageSize = pageSizedToColumns(
    compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE,
    phone ? 1 : fitColumns,
  );

  const load = () => {
    setLoading(true);
    setLoadError(null);
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
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, pageSize, query, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(FAV_COLUMNS_KEY, String(columns));
  }, [columns]);

  const saveNote = async (img: ImageRow) => {
    const draft = (notes[img.id] ?? "").trim();
    if (draft === (img.note ?? "")) return;
    try {
      await api.patchImage(img.id, { note: draft });
      img.note = draft;
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const unfavorite = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: false });
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleContextStar = async (img: ImageRow) => {
    const next = !img.starred;
    try {
      await api.patchImage(img.id, { starred: next });
      img.starred = next ? 1 : 0;
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleTray = (img: ImageRow) => {
    if (trayIds.includes(img.id) && onRemoveFromTray) onRemoveFromTray(img);
    else onUseAsRef?.(img);
  };

  const openFavoriteMenu = (
    generation: Generation,
    img: ImageRow,
    isOutput: boolean,
    trigger: HTMLElement,
    x: number,
    y: number,
    onView: () => void,
  ) => {
    const inTray = trayIds.includes(img.id);
    const shortcuts: ContextMenuShortcut[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: onView,
      },
      ...(onUseAsRef
        ? [
            {
              icon: inTray ? ("removeFromRefs" as const) : ("addToRefs" as const),
              label: inTray ? t("shortcut_remove_ref") : t("shortcut_input"),
              ariaLabel: inTray ? t("remove_ref") : t("add_to_input"),
              onSelect: () => toggleTray(img),
            },
          ]
        : []),
      {
        icon: "favorite",
        label: img.starred ? t("favorited") : t("favorite"),
        ariaLabel: img.starred ? t("unfavorite") : t("favorite"),
        selected: !!img.starred,
        filled: !!img.starred,
        onSelect: () => toggleContextStar(img),
      },
      {
        icon: "download",
        label: t("download"),
        onSelect: () => downloadImage(img),
      },
    ];
    const recordActions: ContextMenuSection = [];
    if (isOutput && generation.prompt) {
      recordActions.push({
        icon: "copy",
        label: t("copy_prompt"),
        onSelect: async () =>
          toast((await copyText(generation.prompt)) ? t("copied") : t("copy_failed")),
      });
      recordActions.push({
        icon: "reuse",
        label: t("reuse"),
        onSelect: () => onReuse(generation),
      });
      if (onRerun && generation.source !== "manual" && isReady(providerOf(generation))) {
        recordActions.push({
          icon: "rerun",
          label: t("rerun_short"),
          onSelect: () => onRerun(generation),
        });
      }
    }
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      prompt: isOutput ? generation.prompt : undefined,
      sourceLabel: generation.source === "manual" ? t("imported_badge") : undefined,
      shortcuts,
      sections: recordActions.length ? [recordActions] : [],
      ariaLabel: t("image_menu"),
    });
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

  return (
    <div ref={rootRef}>
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
          {!phone && (
            <ViewPopover>
              <PopoverSection label={t("columns_per_row")}>
                <Segmented
                  dense
                  value={columns}
                  onChange={(n) => {
                    setColumns(n);
                    setPage(0);
                  }}
                  options={(compact ? FAV_COLUMN_OPTIONS : FAV_COLUMN_OPTIONS_FULL).map((n) => ({
                    value: n,
                    label: String(n),
                  }))}
                />
              </PopoverSection>
            </ViewPopover>
          )}
        </div>
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
            <button onClick={load}>{t("retry")}</button>
          </div>
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
          className={`history-list hlist grid${compact ? " compact" : ""}`}
          style={{ "--history-columns": fitColumns } as CSSProperties}
        >
          {gens.map((g) => {
            const outImg = g.outputImage ?? null;
            return (
              <HistoryItem
                key={g.id}
                g={g}
                layout="grid"
                output={outImg}
                missing={false}
                onOpen={() => outImg && onOpenViewer(outImg, pageOutputs)}
                onToggleStar={outImg ? () => unfavorite(outImg) : undefined}
                onOpenInput={(im) => onOpenViewer(im, g.inputs ?? [])}
                tags={outImg?.tags ?? []}
                onReuse={() => onReuse(g)}
                onRerun={onRerun && isReady(providerOf(g)) ? () => onRerun(g) : undefined}
                onUseAsRef={onUseAsRef && outImg ? () => onUseAsRef(outImg) : undefined}
                onImageContextMenu={(img, trigger, x, y, isOutput, onView) =>
                  openFavoriteMenu(g, img, isOutput, trigger, x, y, onView)
                }
                onEdit={() => setEditingGen(g)}
                onDuplicate={() => setDuplicatingGen(g)}
                header={
                  outImg && (
                    <input
                      className="fav-note"
                      value={notes[outImg.id] ?? ""}
                      placeholder={t("note_placeholder")}
                      aria-label={t("note_placeholder")}
                      onChange={(e) => setNotes((n) => ({ ...n, [outImg.id]: e.target.value }))}
                      onBlur={() => saveNote(outImg)}
                    />
                  )
                }
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
