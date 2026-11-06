import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { type ImageRow, type SeriesGeneration, type SeriesNode, seriesApi } from "../api";
import { useI18n } from "../i18n";
import { cardTime, parseTime } from "../historyTime";
import { useSeries } from "../seriesStore";
import { useRemote } from "../remote";
import { pressable } from "../a11y";
import appIcon from "../assets/app-icon.png";
import SearchBox from "../components/SearchBox";
import { RemoteChip } from "../components/RemoteIndicator";
import { Collage, SeriesDot, StatusStrip, successRate, sumStats } from "../components/SeriesBits";
import { ImportFromTagDialog, MoveToThemeDialog, SeriesEditDialog } from "../components/SeriesDialogs";
import SeriesDetail from "../components/SeriesDetail";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Button, IconButton } from "../components/ui/Button";
import Icon from "../components/ui/Icon";
import Menu from "../components/ui/Menu";
import Segmented from "../components/ui/Segmented";
import { type ContextMenuItem, openContextMenuFromEvent, useContextMenu } from "../components/ui/ContextMenu";

const VIEW_KEY = "imagen-series-view";
const COLLAPSED_KEY = "imagen-series-collapsed";
type View = "grid" | "list";

function initialView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function initialCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

interface Group {
  key: string;
  themeId: number | null;
  name: string;
  archived: boolean;
  items: SeriesNode[];
}

type Dialog =
  | { kind: "new-theme" }
  | { kind: "new-series"; theme: number | null }
  | { kind: "edit"; id: number; name: string; color: string | null }
  | { kind: "move"; id: number; current: number | null }
  | { kind: "import" }
  | null;

export default function Series({
  phone = false,
  refreshKey = 0,
  bound,
  openId,
  onOpenIdChange,
  onOpenViewer,
  onReuse,
  onRerun,
  onOpenInWorkspace,
}: {
  phone?: boolean;
  refreshKey?: number;
  /** series id → workspace numbers bound to it. */
  bound: Map<number, number[]>;
  openId: number | null;
  onOpenIdChange: (id: number | null) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onReuse: (g: SeriesGeneration) => void;
  onRerun?: (g: SeriesGeneration) => void;
  onOpenInWorkspace: (id: number) => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const { remote } = useRemote();
  const store = useSeries();
  const { open: openContextMenu } = useContextMenu();
  const [view, setView] = useState<View>(initialView);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* memory only */
    }
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* memory only */
    }
  }, [collapsed]);

  // Keep the tree fresh when the page is shown or generations finish.
  useEffect(() => {
    void store.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLocaleLowerCase();
    const out: Group[] = [];
    const matches = (themeName: string, s: SeriesNode) =>
      !q || themeName.toLocaleLowerCase().includes(q) || s.name.toLocaleLowerCase().includes(q);
    for (const theme of store.themes) {
      const items = theme.series.filter((s) => {
        const hidden = !!s.archived || !!theme.archived;
        return hidden === archived && matches(theme.name, s);
      });
      const themeShown = archived ? !!theme.archived || items.length > 0 : !theme.archived;
      if (!themeShown) continue;
      if (q && items.length === 0 && !theme.name.toLocaleLowerCase().includes(q)) continue;
      out.push({ key: `t${theme.id}`, themeId: theme.id, name: theme.name, archived: !!theme.archived, items });
    }
    const unthemed = (store.tree?.unthemed ?? []).filter(
      (s) => !!s.archived === archived && matches(t("series_no_theme"), s),
    );
    if (unthemed.length) {
      out.push({ key: "none", themeId: null, name: t("series_no_theme"), archived: false, items: unthemed });
    }
    return out;
  }, [store.themes, store.tree, query, archived, t]);

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const now = new Date();
  const lastText = (iso: string | null) => {
    const d = parseTime(iso);
    return d ? cardTime(d, now, lang) : "—";
  };

  const archiveNode = async (id: number, value: boolean) => {
    try {
      await seriesApi.update(id, { archived: value });
      await store.reload();
      toast(value ? t("series_archived_toast") : t("series_unarchived_toast"));
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const deleteNode = async (id: number, name: string, isTheme: boolean, records: number) => {
    const ok = await askConfirm({
      title: isTheme ? t("series_delete_theme_title") : t("series_delete_title"),
      message: isTheme
        ? t("series_delete_theme_message", { name })
        : t("series_delete_message", { name, n: records }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await seriesApi.remove(id);
      await store.reload();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const seriesMenu = (s: SeriesNode): ContextMenuItem[][] => [
    [
      { icon: "view", label: t("series_open"), onSelect: () => onOpenIdChange(s.id) },
      { icon: "reuse", label: t("series_open_in_workspace"), onSelect: () => onOpenInWorkspace(s.id) },
    ],
    [
      { icon: "edit", label: t("series_rename"), onSelect: () => setDialog({ kind: "edit", id: s.id, name: s.name, color: s.color }) },
      { icon: "moveToTheme", label: `${t("series_move_to_theme")}…`, onSelect: () => setDialog({ kind: "move", id: s.id, current: s.parent_id }) },
      s.archived
        ? { icon: "unarchive", label: t("series_unarchive"), onSelect: () => void archiveNode(s.id, false) }
        : { icon: "archive", label: t("series_archive"), onSelect: () => void archiveNode(s.id, true) },
    ],
    [{ icon: "delete", label: t("series_delete"), danger: true, onSelect: () => void deleteNode(s.id, s.name, false, s.records) }],
  ];

  const openSeriesMenu = (s: SeriesNode) => (event: MouseEvent<HTMLElement>) =>
    openContextMenuFromEvent(event, (trigger, x, y) =>
      openContextMenu({
        x,
        y,
        trigger,
        images: s.cover.slice(0, 1),
        title: s.name,
        subtitle: [store.get(s.id)?.theme?.name ?? t("series_no_theme"), t("series_tries_n", { n: s.tries })].join(" · "),
        sections: seriesMenu(s),
        ariaLabel: t("series_menu"),
      }),
    );

  const themeMenuItems = (g: Group) =>
    g.themeId === null
      ? []
      : [
          { label: t("series_new_series"), icon: "add" as const, onSelect: () => setDialog({ kind: "new-series", theme: g.themeId }) },
          { label: t("series_rename"), icon: "edit" as const, onSelect: () => setDialog({ kind: "edit", id: g.themeId!, name: g.name, color: null }) },
          g.archived
            ? { label: t("series_unarchive"), icon: "unarchive" as const, onSelect: () => void archiveNode(g.themeId!, false) }
            : { label: t("series_archive_theme"), icon: "archive" as const, onSelect: () => void archiveNode(g.themeId!, true) },
          { label: t("series_delete_theme"), icon: "delete" as const, danger: true, onSelect: () => void deleteNode(g.themeId!, g.name, true, 0) },
        ];

  if (openId !== null) {
    return (
      <SeriesDetail
        id={openId}
        phone={phone}
        refreshKey={refreshKey}
        boundTo={bound.get(openId) ?? []}
        onBack={() => onOpenIdChange(null)}
        onOpenViewer={onOpenViewer}
        onReuse={onReuse}
        onRerun={onRerun}
        onOpenInWorkspace={onOpenInWorkspace}
      />
    );
  }

  const boundLabel = (id: number) => {
    const ws = bound.get(id);
    return ws?.length ? t("series_ws_short", { n: ws.join(", ") }) : null;
  };

  const card = (s: SeriesNode) => {
    const rate = successRate(s);
    const ws = boundLabel(s.id);
    return (
      <article
        key={s.id}
        className={`series-card${ws ? " bound" : ""}${phone ? " phone" : ""}`}
        aria-label={s.name}
        onClick={() => onOpenIdChange(s.id)}
        onContextMenu={openSeriesMenu(s)}
        {...pressable(() => onOpenIdChange(s.id))}
      >
        <Collage node={s} size={phone ? "mini" : "card"} />
        <div className="series-card-body">
          <div className="series-card-name">
            <SeriesDot color={s.color} />
            <span>{s.name}</span>
            {ws && <span className="series-bound" title={t("series_bound_to", { n: (bound.get(s.id) ?? []).join(", ") })}>{ws}</span>}
          </div>
          <StatusStrip strip={s.strip} max={phone ? 16 : 24} />
          <div className="series-card-meta">
            <span>
              {t("series_tries_n", { n: s.tries })}
              {rate !== null && ` · ${rate}%`}
            </span>
            <span>{lastText(s.last_at)}</span>
          </div>
        </div>
      </article>
    );
  };

  const groupHead = (g: Group, sums: ReturnType<typeof sumStats>) => {
    const open = !collapsed.has(g.key);
    return (
      <div className="series-group-head">
        <button
          type="button"
          className="series-group-toggle"
          aria-expanded={open}
          onClick={() => toggleGroup(g.key)}
        >
          <Icon name={open ? "chevronDown" : "next"} size="sm" />
          <strong>{g.name}</strong>
          <span className="series-group-meta">
            {t("series_group_meta", { n: g.items.length, tries: sums.tries })}
          </span>
        </button>
        {g.themeId !== null && !phone && (
          <>
            <button
              type="button"
              className="series-group-add"
              onClick={() => setDialog({ kind: "new-series", theme: g.themeId })}
            >
              + {t("series_series")}
            </button>
            <Menu
              items={themeMenuItems(g)}
              renderTrigger={({ open: menuOpen, toggle }) => (
                <IconButton icon="more" label={t("series_theme_menu")} aria-expanded={menuOpen} onClick={toggle} />
              )}
            />
          </>
        )}
      </div>
    );
  };

  const empty = groups.length === 0;

  return (
    <div className={`series-page${phone ? " phone" : ""}`}>
      {phone && (
        <div className="phone-head">
          <img className="phone-logo" src={appIcon} alt="" />
          <h1>{t("tab_series")}</h1>
          {remote && <RemoteChip />}
          <Menu
            items={[
              { label: t("series_new_series"), icon: "add", onSelect: () => setDialog({ kind: "new-series", theme: null }) },
              { label: t("series_new_theme"), icon: "moveToTheme", onSelect: () => setDialog({ kind: "new-theme" }) },
              { label: t("series_import_from_tag"), icon: "tag", onSelect: () => setDialog({ kind: "import" }) },
            ]}
            renderTrigger={({ open, toggle }) => (
              <IconButton icon="add" variant="outline" size="md" label={t("new_menu")} aria-expanded={open} onClick={toggle} />
            )}
          />
        </div>
      )}
      <div className="series-toolbar">
        <div className="series-toolbar-row">
          <SearchBox value={query} onChange={setQuery} placeholder={t("series_search")} />
          {!phone && (
            <>
              <Segmented
                className="view-seg"
                value={view}
                onChange={setView}
                options={[
                  { value: "grid", label: t("view_grid"), icon: "columns", iconOnly: true, title: t("view_grid") },
                  { value: "list", label: t("view_list"), icon: "listView", iconOnly: true, title: t("view_list") },
                ]}
              />
              <Button icon="tag" onClick={() => setDialog({ kind: "import" })} title={t("series_import_from_tag")}>
                <span className="series-btn-label">{t("series_import_from_tag")}</span>
              </Button>
              <Menu
                items={[
                  { label: t("series_new_series"), icon: "series", onSelect: () => setDialog({ kind: "new-series", theme: null }) },
                  { label: t("series_new_theme"), icon: "moveToTheme", onSelect: () => setDialog({ kind: "new-theme" }) },
                ]}
                renderTrigger={({ open, toggle }) => (
                  <Button variant="primary" icon="add" aria-expanded={open} onClick={toggle}>
                    {t("series_new")}
                  </Button>
                )}
              />
            </>
          )}
        </div>
        <div className="series-toolbar-row">
          <Segmented
            value={archived ? "archived" : "active"}
            onChange={(v) => setArchived(v === "archived")}
            options={[
              { value: "active", label: t("series_active") },
              { value: "archived", label: t("series_archived") },
            ]}
          />
          {!phone && <span className="series-toolbar-note">{t("series_grouped_note")}</span>}
        </div>
      </div>

      {!store.loaded ? (
        <div className="panel muted"><span className="spinner" /> {t("loading")}</div>
      ) : empty ? (
        <div className="series-empty">
          {query ? (
            <span>{t("no_results")}</span>
          ) : archived ? (
            <span>{t("series_archived_empty")}</span>
          ) : (
            <>
              <strong>{t("series_empty_title")}</strong>
              <span>{t("series_empty_body")}</span>
              <div className="series-empty-actions">
                <Button variant="primary" icon="add" onClick={() => setDialog({ kind: "new-series", theme: null })}>
                  {t("series_new_series")}
                </Button>
                <Button icon="tag" onClick={() => setDialog({ kind: "import" })}>{t("series_import_from_tag")}</Button>
              </div>
            </>
          )}
        </div>
      ) : view === "list" && !phone ? (
        <div className="series-table" role="table" aria-label={t("tab_series")}>
          <div className="series-tr head" role="row">
            <span role="columnheader">{t("series_col_name")}</span>
            <span role="columnheader">{t("series_col_recent")}</span>
            <span role="columnheader" className="num">{t("series_col_tries")}</span>
            <span role="columnheader" className="num">{t("series_col_ok")}</span>
            <span role="columnheader" className="num">{t("series_col_last")}</span>
          </div>
          {groups.map((g) => {
            const sums = sumStats(g.items);
            const open = !collapsed.has(g.key);
            const rate = successRate(sums);
            return (
              <div key={g.key} role="rowgroup">
                <div className="series-tr theme" role="row">
                  <span role="cell">
                    <button type="button" className="series-group-toggle" aria-expanded={open} onClick={() => toggleGroup(g.key)}>
                      <Icon name={open ? "chevronDown" : "next"} size="sm" />
                      <strong>{g.name}</strong>
                      <span className="series-group-meta">{t("series_n_series", { n: g.items.length })}</span>
                    </button>
                  </span>
                  <span role="cell" />
                  <span role="cell" className="num">{sums.tries}</span>
                  <span role="cell" className="num">{rate === null ? "—" : `${rate}%`}</span>
                  <span role="cell" className="num">{lastText(sums.last_at)}</span>
                </div>
                {open &&
                  g.items.map((s) => {
                    const r = successRate(s);
                    const ws = boundLabel(s.id);
                    return (
                      <div
                        key={s.id}
                        className={`series-tr item${ws ? " bound" : ""}`}
                        onClick={() => onOpenIdChange(s.id)}
                        onContextMenu={openSeriesMenu(s)}
                        {...pressable(() => onOpenIdChange(s.id))}
                        role="row"
                      >
                        <span role="cell" className="series-tr-name">
                          <Collage node={s} size="mini" />
                          <SeriesDot color={s.color} />
                          <span className="series-tr-label">{s.name}</span>
                          {ws && <span className="series-bound">{ws}</span>}
                        </span>
                        <span role="cell"><StatusStrip strip={s.strip} max={16} /></span>
                        <span role="cell" className="num">{s.tries}</span>
                        <span role="cell" className="num">{r === null ? "—" : `${r}%`}</span>
                        <span role="cell" className="num muted">{lastText(s.last_at)}</span>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="series-groups">
          {groups.map((g) => {
            const sums = sumStats(g.items);
            const open = !collapsed.has(g.key);
            return (
              <section key={g.key} className="series-group" aria-label={g.name}>
                {groupHead(g, sums)}
                {open &&
                  (g.items.length ? (
                    <div className={phone ? "series-list-phone" : "series-grid"}>{g.items.map(card)}</div>
                  ) : (
                    <p className="series-group-empty">{t("series_theme_empty")}</p>
                  ))}
              </section>
            );
          })}
        </div>
      )}

      {dialog?.kind === "new-theme" && <SeriesEditDialog mode="new-theme" onClose={() => setDialog(null)} />}
      {dialog?.kind === "new-series" && (
        <SeriesEditDialog mode="new-series" initialTheme={dialog.theme} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "edit" && (
        <SeriesEditDialog
          mode="edit"
          id={dialog.id}
          initialName={dialog.name}
          initialColor={dialog.color}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveToThemeDialog id={dialog.id} current={dialog.current} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "import" && (
        <ImportFromTagDialog onClose={() => setDialog(null)} onDone={(id) => onOpenIdChange(id)} />
      )}
    </div>
  );
}
