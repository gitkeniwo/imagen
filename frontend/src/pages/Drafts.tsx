import { type CSSProperties, useEffect, useState } from "react";
import { api, Draft, draftToTaskSpec, ImageRow, providerOf, TaskSpec } from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import DraftEditorModal from "../components/DraftEditorModal";
import { pageSizedToColumns } from "../pageSize";
import SearchBox from "../components/SearchBox";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import GenerationCard from "../components/GenerationCard";
import type { MenuItem } from "../components/ui/Menu";
import Icon from "../components/ui/Icon";
import { IconButton } from "../components/ui/Button";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import Segmented from "../components/ui/Segmented";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
// Use a new key so the previous single-column-only view does not carry a
// legacy saved value into the new two-column default.
const DRAFT_COLUMNS_KEY = "imagen-draft-columns-v2";
const DRAFT_COLUMN_OPTIONS = [1, 2, 3];

function initialDraftColumns() {
  const saved = Number(localStorage.getItem(DRAFT_COLUMNS_KEY));
  return DRAFT_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

export default function Drafts({
  compact = false,
  refreshKey = 0,
  onQueue,
  onOpenViewer,
  onChanged,
  phone = false,
}: {
  compact?: boolean;
  refreshKey?: number;
  onQueue: (task: TaskSpec) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  // Called after a draft is created or removed, so counts elsewhere refresh.
  onChanged?: () => void;
  phone?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { isReady } = useProviders();
  const askConfirm = useConfirm();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [columns, setColumns] = useState(initialDraftColumns);
  const pageSize = pageSizedToColumns(
    compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE,
    phone ? 1 : columns,
  );

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api.listDrafts({ limit: pageSize, offset: page * pageSize, q: query || undefined })
      .then((result) => {
        setDrafts(result.drafts);
        setTotal(result.total);
        if (result.total > 0 && page * pageSize >= result.total) {
          setPage(Math.max(0, Math.ceil(result.total / pageSize) - 1));
        }
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, pageSize, query, refreshKey]);

  useEffect(() => {
    localStorage.setItem(DRAFT_COLUMNS_KEY, String(columns));
  }, [columns]);

  const togglePin = async (draft: Draft) => {
    try {
      await api.updateDraft(draft.id, { pinned: !draft.pinned });
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const queueDraft = async (draft: Draft, removeAfter: boolean) => {
    // Each draft is queued on its own provider, so readiness is per draft.
    if (!isReady(providerOf(draft))) {
      toast(t("draft_need_config"));
      return;
    }
    if (!draft.prompt.trim() && draft.inputImages.length === 0) {
      toast(t("draft_need_content"));
      return;
    }
    if (draft.inputImages.some((img) => !!img.deleted_at)) {
      toast(t("draft_deleted_input"));
      return;
    }
    onQueue(draftToTaskSpec(draft));
    if (!removeAfter) {
      toast(t("draft_queued_kept"));
      return;
    }
    try {
      await api.deleteDraft(draft.id);
      setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
      setTotal((value) => Math.max(0, value - 1));
      onChanged?.();
      toast(t("draft_queued_deleted"));
    } catch (e) {
      toast(t("draft_queued_delete_failed", { msg: (e as Error).message }));
    }
  };

  const deleteDraft = async (draft: Draft) => {
    const ok = await askConfirm({ message: t("confirm_delete_draft_q"), confirmLabel: t("delete"), danger: true });
    if (!ok) return;
    try {
      await api.deleteDraft(draft.id);
      setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
      setTotal((value) => Math.max(0, value - 1));
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pager = total > pageSize ? (
    <div className="pager">
      <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>{t("prev_page")}</button>
      <span className="muted small">{t("page_status", { page: page + 1, pages: pageCount, total })}</span>
      <button disabled={page >= pageCount - 1 || loading} onClick={() => setPage((p) => p + 1)}>{t("next_page")}</button>
    </div>
  ) : null;

  const phonePager = (
    <div className="phone-pager-row">
      <div className="phone-pg">
        {total > pageSize && (
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
          {total > pageSize
            ? t("phone_page_status", { page: page + 1, pages: pageCount })
            : t("phone_total_images", { n: total })}
        </span>
        {total > pageSize && (
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
      {total > pageSize && <span className="phone-pager-total">{t("phone_total_images", { n: total })}</span>}
    </div>
  );

  return (
    <div className="drafts-page">
      <div className="draft-toolbar">
        <SearchBox
          value={query}
          onChange={(value) => { setQuery(value); setPage(0); }}
          placeholder={t("search_placeholder_drafts")}
        />
        <IconButton
          className="draft-new-button"
          variant="outline"
          size="md"
          icon="add"
          label={t("new_draft")}
          onClick={() => setCreating(true)}
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
                options={DRAFT_COLUMN_OPTIONS.map((value) => ({ value, label: String(value) }))}
              />
            </PopoverSection>
          </ViewPopover>
        )}
      </div>
      {phone ? phonePager : pager}

      {loading ? (
        <div className="panel muted"><span className="spinner" /> {t("loading")}</div>
      ) : loadError ? (
        <div className="panel load-error">
          <span className="small">{t("load_error", { msg: loadError })}</span>
          <button onClick={load}>{t("retry")}</button>
        </div>
      ) : drafts.length === 0 ? (
        <div className="panel muted empty-state">
          <span>{query ? t("no_results") : t("drafts_empty")}</span>
          {query && <button onClick={() => setQuery("")}>{t("clear_filters")}</button>}
        </div>
      ) : (
        <div
          className={`draft-list${compact ? " compact" : ""}`}
          style={{ "--draft-columns": columns } as CSSProperties}
        >
          {drafts.map((draft) => {
            const firstOutput = draft.outputImages.find((img) => !img.deleted_at) ?? null;
            const liveOutputs = draft.outputImages.filter((img) => !img.deleted_at);
            const menuItems: MenuItem[] = [
              { icon: "editSettings", label: t("edit_draft"), onSelect: () => setEditing(draft) },
              { icon: "queue", label: t("queue_and_keep"), onSelect: () => queueDraft(draft, false) },
              {
                icon: "pin",
                label: draft.pinned ? t("unpin_draft") : t("pin_draft"),
                onSelect: () => togglePin(draft),
              },
              { icon: "delete", label: t("delete"), danger: true, onSelect: () => deleteDraft(draft) },
            ];
            return (
              <GenerationCard
                key={draft.id}
                media={
                  firstOutput
                    ? { kind: "image", image: firstOutput, onOpen: () => onOpenViewer(firstOutput, liveOutputs) }
                    : { kind: "empty" }
                }
                aspectRatio={draft.aspect_ratio}
                extraBadges={
                  liveOutputs.length > 1 && (
                    <span className="badge imported" title={t("draft_outputs")}>
                      {t("draft_outputs_n", { n: liveOutputs.length })}
                    </span>
                  )
                }
                overlay={
                  <IconButton
                    variant={firstOutput ? "overlay" : "ghost"}
                    className={`draft-pin${draft.pinned ? " is-pinned" : ""}`}
                    icon="pin"
                    filled={!!draft.pinned}
                    label={draft.pinned ? t("unpin_draft") : t("pin_draft")}
                    aria-pressed={!!draft.pinned}
                    onClick={() => togglePin(draft)}
                  />
                }
                header={
                  !draft.prompt && (
                    <button type="button" className="link-btn draft-empty-prompt" onClick={() => setEditing(draft)}>
                      {t("draft_empty_prompt")}
                    </button>
                  )
                }
                meta={[draft.model.replace("-image", ""), draft.aspect_ratio, draft.resolution]}
                prompt={draft.prompt}
                promptLines={compact ? 3 : 4}
                inputs={draft.inputImages}
                onOpenInput={(img) => onOpenViewer(img, draft.inputImages.filter((item) => !item.deleted_at))}
                tags={draft.tags}
                actions={[
                  {
                    icon: "queue",
                    label: t("draft_queue_short"),
                    title: t("queue_and_delete_hint"),
                    primary: true,
                    onClick: () => queueDraft(draft, true),
                  },
                ]}
                menuItems={menuItems}
              />
            );
          })}
        </div>
      )}
      {!phone && pager}

      {creating && (
        <DraftEditorModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            load();
            onChanged?.();
          }}
        />
      )}
      {editing && (
        <DraftEditorModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

