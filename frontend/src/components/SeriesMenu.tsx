import { useCallback, useState } from "react";
import { api, seriesApi, type SeriesAssignBody } from "../api";
import { useConfirm } from "./ConfirmDialog";
import { useI18n } from "../i18n";
import { seriesPathText, useSeries } from "../seriesStore";
import { useSeriesNav } from "../seriesContext";
import { SeriesDot } from "./SeriesBits";

// Menu rows: an <i> dot (rows read their label from the first <span>).
const menuDot = (color: string | null | undefined) => (
  <i className="series-dot" style={{ background: color ?? undefined }} aria-hidden="true" />
);
import Icon from "./ui/Icon";
import type { ContextMenuItem } from "./ui/ContextMenu";
import SeriesPicker from "./SeriesPicker";
import { SeriesEditDialog } from "./SeriesDialogs";
import { useToast } from "./Toast";

export interface SeriesTarget {
  /** What to send to assign/unassign. */
  body: SeriesAssignBody;
  /** Current series of each selected item (null = none), for "2 of 3". */
  members: (number | null)[];
}

/**
 * "Add to series ›" for History / Library menus and batch bars. Returns the
 * menu item builder, a direct `assign`, and the dialog element the page must
 * render (for "New series from selection…").
 */
export function useSeriesActions(onChanged?: () => void) {
  const { t } = useI18n();
  const toast = useToast();
  const store = useSeries();
  const [newFor, setNewFor] = useState<SeriesTarget | null>(null);
  const askConfirm = useConfirm();

  /**
   * series-v2 B1a: filing images moves their records out of other series.
   * Count that up front (membership → each record's series) and ask first;
   * pure additions stay instant.
   */
  const confirmImageMove = useCallback(
    async (imageIds: number[], id: number): Promise<boolean> => {
      const genIds: number[] = [];
      for (let i = 0; i < imageIds.length; i += 500) {
        const { items } = await seriesApi.membership(imageIds.slice(i, i + 500));
        for (const item of items) genIds.push(...item.generationIds);
      }
      const unique = [...new Set(genIds)];
      const from = new Map<number, number>();
      let unfiled = 0;
      for (let i = 0; i < unique.length; i += 500) {
        const { items } = await api.seriesPositions(unique.slice(i, i + 500));
        for (const p of items) {
          if (p.seriesId === null) unfiled++;
          else if (p.seriesId !== id) from.set(p.seriesId, (from.get(p.seriesId) ?? 0) + 1);
        }
      }
      const moved = [...from.values()].reduce((a, b) => a + b, 0);
      if (moved === 0) return true;
      const name = store.get(id)?.name ?? "";
      return askConfirm({
        title: t("sv2_move_title", { n: moved, series: name }),
        message: t("sv2_move_body"),
        aboveViewer: true,
        confirmLabel: t("sv2_move_confirm", { n: moved }),
        details: (
          <ul className="sv2-move-list">
            {[...from.entries()].map(([sid, n]) => {
              const path = store.get(sid);
              return (
                <li key={sid}>
                  <SeriesDot color={path?.color} />
                  <span>{t("sv2_move_from", { n, series: path?.name ?? "?" })}</span>
                </li>
              );
            })}
            {unfiled > 0 && (
              <li className="muted">
                <SeriesDot color={null} />
                <span>{t("sv2_move_unfiled", { n: unfiled })}</span>
              </li>
            )}
          </ul>
        ),
      });
    },
    [askConfirm, store, t],
  );

  const assign = useCallback(
    async (target: SeriesTarget, id: number | null) => {
      try {
        if (id !== null && target.body.imageIds?.length) {
          if (!(await confirmImageMove(target.body.imageIds, id))) return;
        }
        if (id === null) {
          await seriesApi.unassign(target.body);
          toast(t("series_removed_toast", { n: target.members.length }));
        } else {
          const res = await seriesApi.assign(id, target.body);
          const name = store.get(id)?.name ?? "";
          toast(
            res.moved > 0
              ? t("series_assigned_moved_toast", { n: res.generations + res.drafts, name, m: res.moved })
              : t("series_assigned_toast", { n: res.generations + res.drafts, name }),
            "success",
          );
        }
        await store.reload();
        onChanged?.();
      } catch (e) {
        toast(t("op_failed", { msg: (e as Error).message }), "error");
      }
    },
    [confirmImageMove, onChanged, store, t, toast],
  );

  const picker = useCallback(
    (target: SeriesTarget, close: () => void, focus: boolean) => {
      const total = target.members.length;
      const anyIn = target.members.some((m) => m !== null);
      const single = total === 1 ? target.members[0] : null;
      return (
        <SeriesPicker
          store={store}
          value={single}
          autoFocus={focus}
          onClose={close}
          onPick={(id) => {
            // Close the menu first: a move confirmation must not sit under it.
            close();
            return assign(target, id);
          }}
          hint={(s) => {
            const n = target.members.filter((m) => m === s.id).length;
            return total > 1 && n > 0 ? t("series_n_of_m", { n, m: total }) : null;
          }}
          actions={[
            { id: "new", label: t("series_new_from_selection"), icon: "add", onSelect: () => setNewFor(target) },
            {
              id: "remove",
              label: t("series_remove_from"),
              icon: "remove",
              danger: true,
              disabled: !anyIn,
              onSelect: () => void assign(target, null),
            },
          ]}
        />
      );
    },
    [assign, store, t],
  );

  const menuItem = useCallback(
    (target: SeriesTarget | null): ContextMenuItem => {
      if (!target || target.members.length === 0) {
        return { id: "series", icon: "series", label: t("series_add_to"), disabled: true, hint: t("series_upload_short") };
      }
      const inSeries = target.members.filter((m) => m !== null);
      const one = new Set(inSeries).size === 1 && inSeries.length === target.members.length ? store.get(inSeries[0]) : null;
      return {
        id: "series",
        icon: "series",
        label: t("series_add_to"),
        hint: one?.name,
        submenu: { kind: "custom", render: (close, focus) => picker(target, close, focus) },
      };
    },
    [picker, store, t],
  );

  const nav = useSeriesNav();
  /**
   * series-v2 B1a: "Open “X”" for items already in a series (History,
   * Favorites, Drafts, Queue, Viewer, Library). `seriesIds` most recent first;
   * several become "Open series ›" with the full paths. Null when none.
   */
  const openItem = useCallback(
    (seriesIds: (number | null | undefined)[]): ContextMenuItem | null => {
      const ids = [...new Set(seriesIds.filter((id): id is number => !!id))].filter((id) => store.get(id));
      if (ids.length === 0) return null;
      if (ids.length === 1) {
        const path = store.get(ids[0])!;
        const name = path.name.length > 22 ? `${path.name.slice(0, 21)}…` : path.name;
        return {
          id: "open-series",
          leading: menuDot(path.color),
          label: t("sv2_menu_open", { series: name }),
          hint: <Icon name="openSeries" size="sm" />,
          onSelect: () => nav.openSeries(ids[0]),
        };
      }
      return {
        id: "open-series",
        leading: menuDot(store.get(ids[0])?.color),
        label: t("sv2_menu_open_multi"),
        hint: ids.length,
        submenu: {
          kind: "items",
          items: ids.map((id) => {
            const path = store.get(id)!;
            return {
              id: `open-series-${id}`,
              leading: menuDot(path.color),
              label: seriesPathText(path, t("series_no_theme")),
              onSelect: () => nav.openSeries(id),
            };
          }),
        },
      };
    },
    [nav, store, t],
  );

  /** The series rows of a context menu: [Open “X”], Add to series ›. */
  const section = useCallback(
    (openIds: (number | null | undefined)[], target: SeriesTarget | null): ContextMenuItem[] => {
      const open = openItem(openIds);
      return open ? [open, menuItem(target)] : [menuItem(target)];
    },
    [menuItem, openItem],
  );

  const dialog = newFor ? (
    <SeriesEditDialog
      mode="new-series"
      initialTheme={store.get(newFor.members.find((m) => m !== null) ?? null)?.theme?.id ?? null}
      onClose={() => setNewFor(null)}
      onDone={(id) => void assign(newFor, id)}
    />
  ) : null;

  return { menuItem, openItem, section, picker, assign, dialog };
}
