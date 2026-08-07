import { type CSSProperties, useEffect, useState } from "react";
import { api, Draft, draftToTaskSpec, ImageRow, TaskSpec, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import DraftEditorModal from "../components/DraftEditorModal";
import SearchBox from "../components/SearchBox";
import { useToast } from "../components/Toast";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
// Use a new key so the previous single-column-only view does not carry a
// legacy saved value into the new two-column default.
const DRAFT_COLUMNS_KEY = "imagen-draft-columns-v2";
const DRAFT_COLUMN_OPTIONS = [1, 2, 3];
const PROMPT_PREVIEW_CHARS = 240;
const PROMPT_PREVIEW_LINES = 4;

function initialDraftColumns() {
  const saved = Number(localStorage.getItem(DRAFT_COLUMNS_KEY));
  return DRAFT_COLUMN_OPTIONS.includes(saved) ? saved : 2;
}

export default function Drafts({
  compact = false,
  refreshKey = 0,
  canQueue,
  onQueue,
  onOpenViewer,
}: {
  compact?: boolean;
  refreshKey?: number;
  canQueue: boolean;
  onQueue: (task: TaskSpec) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<number | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [deleting, setDeleting] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [columns, setColumns] = useState(initialDraftColumns);
  const pageSize = compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE;

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

  const toggleExpanded = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const patchLocal = (draft: Draft) =>
    setDrafts((prev) => prev.map((item) => (item.id === draft.id ? draft : item)));

  const togglePin = async (draft: Draft) => {
    try {
      await api.updateDraft(draft.id, { pinned: !draft.pinned });
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const savePrompt = async (draft: Draft) => {
    if (editingPrompt !== draft.id) return;
    const next = promptValue;
    setEditingPrompt(null);
    if (next === draft.prompt) return;
    patchLocal({ ...draft, prompt: next });
    try {
      patchLocal(await api.updateDraft(draft.id, { prompt: next }));
    } catch (e) {
      patchLocal(draft);
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const queueDraft = async (draft: Draft, removeAfter: boolean) => {
    if (!canQueue) {
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
      toast(t("draft_queued_deleted"));
    } catch (e) {
      toast(t("draft_queued_delete_failed", { msg: (e as Error).message }));
    }
  };

  const deleteDraft = async (draft: Draft) => {
    if (deleting !== draft.id) {
      setDeleting(draft.id);
      return;
    }
    try {
      await api.deleteDraft(draft.id);
      setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
      setTotal((value) => Math.max(0, value - 1));
      setDeleting(null);
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

  return (
    <div className="drafts-page">
      <div className="draft-toolbar">
        <SearchBox
          value={query}
          onChange={(value) => { setQuery(value); setPage(0); }}
          placeholder={t("search_placeholder_drafts")}
        />
        <button className="primary draft-new-button" onClick={() => setCreating(true)}>
          <i className="fa-solid fa-plus" /> {t("new_draft")}
        </button>
        <div className="seg density-seg draft-columns" title={t("columns_per_row")}>
          {DRAFT_COLUMN_OPTIONS.map((value) => (
            <button
              key={value}
              className={columns === value ? "on" : ""}
              onClick={() => setColumns(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {pager}

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
            const promptNeedsToggle =
              draft.prompt.length > PROMPT_PREVIEW_CHARS ||
              draft.prompt.split(/\r?\n/).length > PROMPT_PREVIEW_LINES;
            return (
            <div className={`panel draft-card${draft.pinned ? " pinned" : ""}`} key={draft.id}>
              <div className="draft-card-head">
                <button
                  className={`icon-btn draft-pin${draft.pinned ? " is-pinned" : ""}`}
                  title={draft.pinned ? t("unpin_draft") : t("pin_draft")}
                  onClick={() => togglePin(draft)}
                >
                  <i className="fa-solid fa-thumbtack" />
                </button>
                <span className="muted small">{draft.model.replace("-image", "")}</span>
                {draft.aspect_ratio && <span className="muted small">· {draft.aspect_ratio}</span>}
                {draft.resolution && <span className="muted small">· {draft.resolution}</span>}
                <div className="spacer" />
                <button className="icon-btn" title={t("edit_draft")} onClick={() => setEditing(draft)}>
                  <i className="fa-solid fa-sliders" />
                </button>
              </div>

              {editingPrompt === draft.id ? (
                <textarea
                  className="draft-inline-prompt"
                  autoFocus
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onBlur={() => savePrompt(draft)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { setPromptValue(draft.prompt); setEditingPrompt(null); }
                  }}
                />
              ) : (
                <div className="draft-prompt-wrap">
                  {expanded.has(draft.id) && promptNeedsToggle && (
                    <button
                      className="link-btn draft-prompt-toggle-top"
                      onClick={() => toggleExpanded(draft.id)}
                    >
                      {t("show_less")}
                    </button>
                  )}
                  <div className={`draft-prompt${draft.prompt ? "" : " empty"}`}>
                    <p className={expanded.has(draft.id) ? "expanded" : ""}>
                      {draft.prompt || t("draft_empty_prompt")}
                    </p>
                    <button
                      className="q-icon-btn"
                      title={t("edit_prompt_inline")}
                      onClick={() => { setPromptValue(draft.prompt); setEditingPrompt(draft.id); }}
                    >
                      <i className="fa-solid fa-pen" />
                    </button>
                  </div>
                  {promptNeedsToggle && (
                    <button className="link-btn" onClick={() => toggleExpanded(draft.id)}>
                      {expanded.has(draft.id) ? t("show_less") : t("show_more")}
                    </button>
                  )}
                </div>
              )}

              <div className="draft-images-row">
                <DraftImages
                  label={t("draft_inputs")}
                  images={draft.inputImages}
                  onOpenViewer={onOpenViewer}
                />
                <span className="arrow">→</span>
                <DraftImages
                  label={t("draft_outputs")}
                  images={draft.outputImages}
                  onOpenViewer={onOpenViewer}
                />
              </div>

              {draft.tags.length > 0 && (
                <div className="card-tags">
                  {draft.tags.map((tag) => <span className="card-tag" key={tag.id}>{tag.name}</span>)}
                </div>
              )}

              <div className="draft-actions">
                <button className="primary" onClick={() => queueDraft(draft, true)}>{t("queue_and_delete")}</button>
                <button onClick={() => queueDraft(draft, false)}>{t("queue_and_keep")}</button>
                <button
                  className={deleting === draft.id ? "danger" : ""}
                  onBlur={() => setDeleting((id) => id === draft.id ? null : id)}
                  onClick={() => deleteDraft(draft)}
                >
                  {deleting === draft.id ? t("confirm_delete_draft") : t("delete")}
                </button>
              </div>
            </div>
          );})}
        </div>
      )}
      {pager}

      {creating && (
        <DraftEditorModal
          onClose={() => setCreating(false)}
          onSaved={() => load()}
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

function DraftImages({
  label,
  images,
  onOpenViewer,
}: {
  label: string;
  images: ImageRow[];
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="draft-image-group">
      <span className="muted small">{label}</span>
      <div className="draft-thumbs">
        {images.map((img) => img.deleted_at ? (
          <span className="deleted-tile" key={img.id} title={t("deleted_label")}>
            <i className="fa-solid fa-trash-can" />
          </span>
        ) : (
          <img
            key={img.id}
            src={imgThumbUrl(img.id)}
            alt={img.filename}
            title={img.filename}
            onClick={() => onOpenViewer(img, images.filter((item) => !item.deleted_at))}
          />
        ))}
        {images.length === 0 && <span className="muted small">—</span>}
      </div>
    </div>
  );
}
