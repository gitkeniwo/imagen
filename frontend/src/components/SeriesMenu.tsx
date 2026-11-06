import { useCallback, useState } from "react";
import { seriesApi, type SeriesAssignBody } from "../api";
import { useI18n } from "../i18n";
import { useSeries } from "../seriesStore";
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

  const assign = useCallback(
    async (target: SeriesTarget, id: number | null) => {
      try {
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
    [onChanged, store, t, toast],
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
          onPick={(id) => assign(target, id)}
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

  const dialog = newFor ? (
    <SeriesEditDialog
      mode="new-series"
      initialTheme={store.get(newFor.members.find((m) => m !== null) ?? null)?.theme?.id ?? null}
      onClose={() => setNewFor(null)}
      onDone={(id) => void assign(newFor, id)}
    />
  ) : null;

  return { menuItem, picker, assign, dialog };
}
