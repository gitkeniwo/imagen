import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SeriesNode } from "../api";
import { useI18n } from "../i18n";
import { type SeriesStore, useSeries } from "../seriesStore";
import { useToast } from "./Toast";
import Icon, { type IconName } from "./ui/Icon";

export interface SeriesPickerAction {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

type Row =
  | { key: string; kind: "series"; series: SeriesNode; path: boolean; indent: boolean }
  | { key: string; kind: "theme"; id: number | null; name: string; count: number; open: boolean }
  | { key: string; kind: "label"; text: string }
  | { key: string; kind: "sep" }
  | { key: string; kind: "create"; themeId: number | null; themeName: string | null; name?: string }
  | { key: string; kind: "none" }
  | { key: string; kind: "action"; action: SeriesPickerAction };

const selectable = (row: Row) =>
  row.kind !== "label" && row.kind !== "sep" && !(row.kind === "action" && row.action.disabled);

const fold = (s: string) => s.toLocaleLowerCase();

/**
 * The one series picker: composer Series row, context-menu submenu, batch bar.
 * Search matches series and theme names; "theme/series" matches a path.
 * ↑/↓ move, Enter picks, theme rows fold on Enter.
 */
export default function SeriesPicker({
  value,
  onPick,
  hint,
  noneLabel,
  actions = [],
  autoFocus = true,
  onClose,
  store: storeProp,
}: {
  value: number | null;
  onPick: (id: number | null) => void | Promise<void>;
  /** Right-aligned note per series (tries, "2 of 3"). */
  hint?: (series: SeriesNode) => ReactNode;
  /** Shown as the last row; picking it calls onPick(null). Omit to hide. */
  noneLabel?: string;
  actions?: SeriesPickerAction[];
  autoFocus?: boolean;
  onClose?: () => void;
  /** Pass when rendered outside the series context (the context menu portal). */
  store?: SeriesStore;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const contextStore = useSeries();
  const store = storeProp ?? contextStore;
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<{ themeId: number | null; name: string } | null>(null);
  const currentTheme = store.get(value)?.theme?.id ?? null;
  const [open, setOpen] = useState<Set<number | null>>(() => new Set([currentTheme]));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [autoFocus]);

  const liveLeaves = useMemo(
    () => store.leaves.filter((leaf) => !store.get(leaf.id)?.archived),
    [store],
  );
  const liveThemes = useMemo(() => store.themes.filter((theme) => !theme.archived), [store.themes]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const q = query.trim();
    if (q) {
      const slash = q.indexOf("/");
      const themePart = slash >= 0 ? fold(q.slice(0, slash).trim()) : null;
      const namePart = fold(slash >= 0 ? q.slice(slash + 1).trim() : q);
      const hits = liveLeaves.filter((leaf) => {
        const themeName = fold(store.get(leaf.id)?.theme?.name ?? t("series_no_theme"));
        if (themePart !== null) {
          return themeName.includes(themePart) && fold(leaf.name).includes(namePart);
        }
        return fold(leaf.name).includes(namePart) || themeName.includes(namePart);
      });
      for (const leaf of hits) out.push({ key: `s${leaf.id}`, kind: "series", series: leaf, path: true, indent: false });
      if (hits.length === 0) out.push({ key: "empty", kind: "label", text: t("series_picker_no_match") });
      // Offer to create what was typed, under the typed theme when it exists.
      const name = slash >= 0 ? q.slice(slash + 1).trim() : q;
      if (name) {
        const theme =
          themePart !== null
            ? liveThemes.find((th) => fold(th.name) === themePart) ??
              liveThemes.find((th) => fold(th.name).includes(themePart))
            : liveThemes.find((th) => th.id === currentTheme);
        const exists = liveLeaves.some(
          (leaf) => fold(leaf.name) === fold(name) && (leaf.parent_id ?? null) === (theme?.id ?? null),
        );
        if (!exists) {
          out.push({ key: "sep-create", kind: "sep" });
          out.push({
            key: "create-typed",
            kind: "create",
            themeId: theme?.id ?? null,
            themeName: theme?.name ?? null,
            name,
          });
        }
      }
    } else {
      const recent = store.recent.map((id) => store.node(id)).filter((n): n is SeriesNode => !!n);
      if (recent.length) {
        out.push({ key: "recent", kind: "label", text: t("series_recent") });
        for (const leaf of recent) out.push({ key: `r${leaf.id}`, kind: "series", series: leaf, path: true, indent: false });
        out.push({ key: "sep-recent", kind: "sep" });
      }
      const groups: { id: number | null; name: string; items: SeriesNode[] }[] = [
        ...liveThemes.map((theme) => ({
          id: theme.id as number | null,
          name: theme.name,
          items: theme.series.filter((s) => !s.archived),
        })),
        { id: null, name: t("series_no_theme"), items: (store.tree?.unthemed ?? []).filter((s) => !s.archived) },
      ];
      for (const group of groups) {
        if (group.id === null && group.items.length === 0) continue;
        const isOpen = open.has(group.id);
        out.push({ key: `t${group.id ?? "none"}`, kind: "theme", id: group.id, name: group.name, count: group.items.length, open: isOpen });
        if (!isOpen) continue;
        for (const leaf of group.items) out.push({ key: `s${leaf.id}`, kind: "series", series: leaf, path: false, indent: true });
      }
      const theme = liveThemes.find((th) => th.id === currentTheme) ?? null;
      out.push({ key: "create", kind: "create", themeId: theme?.id ?? null, themeName: theme?.name ?? null });
    }
    if (actions.length || noneLabel) out.push({ key: "sep-end", kind: "sep" });
    for (const action of actions) out.push({ key: `a-${action.id}`, kind: "action", action });
    if (noneLabel) out.push({ key: "none", kind: "none" });
    return out;
  }, [query, liveLeaves, liveThemes, store, open, currentTheme, actions, noneLabel, t]);

  const choices = rows.map((row, index) => (selectable(row) ? index : -1)).filter((i) => i >= 0);
  const activeIndex = choices.includes(active) ? active : choices[0] ?? -1;

  useEffect(() => {
    setActive(-1);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const pick = async (id: number | null) => {
    if (id !== null) store.markRecent(id);
    await onPick(id);
    onClose?.();
  };

  const submitCreate = async (themeId: number | null, raw: string) => {
    const name = raw.trim();
    if (!name) return;
    try {
      const created = await store.create("series", name, themeId);
      setCreating(null);
      await pick(created.id);
    } catch (e) {
      toast(
        (e as { detail?: string }).detail === "name_taken"
          ? t("series_name_taken")
          : t("op_failed", { msg: (e as Error).message }),
        "error",
      );
    }
  };

  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "series") void pick(row.series.id);
    else if (row.kind === "theme") {
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setActive(index);
    } else if (row.kind === "create") {
      if (row.name) void submitCreate(row.themeId, row.name);
      else setCreating({ themeId: row.themeId, name: "" });
    } else if (row.kind === "none") void pick(null);
    else if (row.kind === "action" && !row.action.disabled) {
      row.action.onSelect();
      onClose?.();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Menus and pages around the picker must not see its keys.
    event.stopPropagation();
    if (creating && (event.target as HTMLElement).dataset.createInput !== undefined) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (choices.length === 0) return;
      const at = choices.indexOf(activeIndex);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(choices[(at + step + choices.length) % choices.length]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) activate(activeIndex);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const row = rows[activeIndex];
      if (row?.kind === "theme" && !query && (event.key === "ArrowRight") !== row.open) {
        event.preventDefault();
        activate(activeIndex);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (creating) setCreating(null);
      else onClose?.();
    }
  };

  const rowId = (index: number) => `${listId}-row-${index}`;

  return (
    <div className="series-picker" onKeyDown={onKeyDown}>
      <label className="series-picker-search">
        <Icon name="search" size="sm" />
        <input
          ref={inputRef}
          value={query}
          placeholder={t("series_picker_search")}
          aria-label={t("series_picker_search")}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? rowId(activeIndex) : undefined}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="series-picker-list" role="listbox" id={listId} ref={listRef} aria-label={t("series_pick")}>
        {rows.map((row, index) => {
          const isActive = index === activeIndex;
          const common = {
            id: rowId(index),
            "data-row": index,
            className: `series-picker-row${isActive ? " active" : ""}`,
            onMouseMove: () => selectable(row) && activeIndex !== index && setActive(index),
            onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
            onClick: () => activate(index),
          };
          switch (row.kind) {
            case "label":
              return <div key={row.key} className="series-picker-label">{row.text}</div>;
            case "sep":
              return <div key={row.key} className="series-picker-sep" role="separator" />;
            case "theme":
              return (
                <div key={row.key} {...common} className={`${common.className} theme`} role="option" aria-selected={false} aria-expanded={row.open}>
                  <Icon name={row.open ? "chevronDown" : "next"} size="sm" />
                  <span className="series-picker-name">{row.name}</span>
                  <span className="series-picker-hint">{row.count}</span>
                </div>
              );
            case "series": {
              const path = store.get(row.series.id);
              const selected = row.series.id === value;
              return (
                <div
                  key={row.key}
                  {...common}
                  className={`${common.className}${row.indent ? " indent" : ""}`}
                  role="option"
                  aria-selected={selected}
                  title={`${path?.theme?.name ?? t("series_no_theme")} / ${row.series.name}`}
                >
                  <span className="series-dot" style={{ background: row.series.color ?? undefined }} />
                  {row.path && (
                    <span className="series-picker-theme">{path?.theme?.name ?? t("series_no_theme")} /</span>
                  )}
                  <span className="series-picker-name">{row.series.name}</span>
                  {hint ? (
                    <span className="series-picker-hint">{hint(row.series)}</span>
                  ) : (
                    !row.path && <span className="series-picker-hint">{row.series.tries}</span>
                  )}
                  {selected && <Icon name="check" size="sm" className="series-picker-check" />}
                </div>
              );
            }
            case "create":
              if (creating && !row.name) {
                return (
                  <div key={row.key} className="series-picker-row create editing">
                    <Icon name="add" size="sm" />
                    <input
                      autoFocus
                      data-create-input
                      value={creating.name}
                      placeholder={row.themeName ? t("series_new_in", { theme: row.themeName }) : t("series_new_name")}
                      aria-label={t("series_new_name")}
                      onChange={(event) => setCreating({ ...creating, name: event.target.value })}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitCreate(creating.themeId, creating.name);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setCreating(null);
                          inputRef.current?.focus();
                        }
                      }}
                    />
                  </div>
                );
              }
              return (
                <div key={row.key} {...common} className={`${common.className} create`} role="option" aria-selected={false}>
                  <Icon name="add" size="sm" />
                  <span className="series-picker-name">
                    {row.name
                      ? t("series_create_named", { name: row.name, theme: row.themeName ?? t("series_no_theme") })
                      : row.themeName
                        ? t("series_new_in", { theme: row.themeName })
                        : t("series_new_series")}
                  </span>
                </div>
              );
            case "action":
              return (
                <div
                  key={row.key}
                  {...common}
                  className={`${common.className}${row.action.danger ? " danger" : ""}${row.action.disabled ? " disabled" : ""}`}
                  role="option"
                  aria-selected={false}
                  aria-disabled={row.action.disabled}
                >
                  {row.action.icon ? <Icon name={row.action.icon} size="sm" /> : <span className="series-picker-gap" />}
                  <span className="series-picker-name">{row.action.label}</span>
                </div>
              );
            case "none":
              return (
                <div key={row.key} {...common} className={`${common.className} none`} role="option" aria-selected={value === null}>
                  <span className="series-picker-gap" />
                  <span className="series-picker-name">{noneLabel}</span>
                  {value === null && <Icon name="check" size="sm" className="series-picker-check" />}
                </div>
              );
          }
        })}
      </div>
    </div>
  );
}
