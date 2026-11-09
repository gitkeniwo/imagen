import {
  createContext,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type ImageRow, imgThumbUrl } from "../../api";
import { displayName } from "../../displayName";
import { useI18n } from "../../i18n";
import Icon, { type IconName } from "./Icon";

const EDGE = 8;
const SUBMENU_GAP = 4;
const FIXED_Z = 220;

export interface ContextMenuQuickAction {
  id?: string;
  label: string;
  icon: IconName;
  ariaLabel?: string;
  selected?: boolean;
  filled?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface ContextMenuTagOption {
  id: number;
  name: string;
  count: number;
  checked: boolean;
}

export interface ContextMenuTagSubmenu {
  kind: "tags";
  options: ContextMenuTagOption[];
  onToggle: (id: number) => void | Promise<void>;
  createLabel?: string;
  createPlaceholder?: string;
  onCreate?: (name: string) => void | Promise<void>;
}

export interface ContextMenuListSubmenu {
  kind: "items";
  items: ContextMenuItem[];
}

// Arbitrary content (the series picker). `close` dismisses the whole menu;
// `focus` is true when the submenu was opened from the keyboard or a click.
export interface ContextMenuCustomSubmenu {
  kind: "custom";
  render: (close: () => void, focus: boolean) => ReactNode;
}

export type ContextMenuSubmenu =
  | ContextMenuTagSubmenu
  | ContextMenuListSubmenu
  | ContextMenuCustomSubmenu;

export interface ContextMenuItem {
  id?: string;
  label: string;
  icon?: IconName;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  submenu?: ContextMenuSubmenu;
  onSelect?: () => void | Promise<void>;
}

export type ContextMenuSection = ContextMenuItem[];

export interface ContextMenuConfig {
  x: number;
  y: number;
  trigger: HTMLElement;
  images: ImageRow[];
  prompt?: string | null;
  promptLoader?: () => Promise<string | null | undefined>;
  sourceLabel?: string;
  title?: string;
  subtitle?: string;
  quickActions?: ContextMenuQuickAction[];
  sections: ContextMenuSection[];
  ariaLabel?: string;
}

interface OpenMenu extends ContextMenuConfig {
  key: number;
}

interface MenuController {
  open: (config: ContextMenuConfig) => void;
  close: (restoreFocus?: boolean) => void;
}

const ContextMenuContext = createContext<MenuController | null>(null);

export function useContextMenu() {
  const value = useContext(ContextMenuContext);
  if (!value) throw new Error("useContextMenu must be used inside ContextMenuProvider");
  return value;
}

export function openContextMenuFromEvent(
  event: ReactMouseEvent<HTMLElement>,
  open: (trigger: HTMLElement, x: number, y: number) => void,
  trigger: HTMLElement = event.currentTarget,
) {
  event.preventDefault();
  const pointerType = (event.nativeEvent as PointerEvent).pointerType ?? "";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (pointerType !== "mouse" && (pointerType || coarse)) return;
  open(trigger, event.clientX, event.clientY);
}

export function openContextMenuFromKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  open: (trigger: HTMLElement, x: number, y: number) => void,
) {
  if (!((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  open(event.currentTarget, rect.left + Math.min(rect.width / 2, 18), rect.top + 18);
  return true;
}

const itemId = (item: ContextMenuItem) => item.id ?? item.label;

const run = (action: () => void | Promise<void>) => {
  try {
    void Promise.resolve(action()).catch(() => {});
  } catch {
    /* The caller owns error feedback. */
  }
};

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [submenu, setSubmenu] = useState<{
    id: string;
    item: ContextMenuItem;
    anchor: HTMLElement;
    focus: boolean;
  } | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<OpenMenu | null>(null);
  const nextKey = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const clearHighlight = useCallback(() => {
    highlightRef.current?.classList.remove("context-menu-target");
    highlightRef.current = null;
    triggerRef.current = null;
  }, []);

  const close = useCallback(
    (restoreFocus = false) => {
      const trigger = triggerRef.current;
      clearHighlight();
      menuRef.current = null;
      setMenu(null);
      setPos(null);
      setSubmenu(null);
      setSubPos(null);
      setCreatingTag(false);
      setNewTagName("");
      if (restoreFocus) {
        window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
      }
    },
    [clearHighlight],
  );

  const closeSubmenu = useCallback(
    (restoreFocus = false) => {
      const current = submenu;
      setSubmenu(null);
      setSubPos(null);
      setCreatingTag(false);
      setNewTagName("");
      if (restoreFocus && current) {
        window.requestAnimationFrame(() =>
          rowRefs.current.get(current.id)?.focus({ preventScroll: true }),
        );
      }
    },
    [submenu],
  );

  const open = useCallback(
    (config: ContextMenuConfig) => {
      if (menuRef.current) close(false);
      highlightRef.current = config.trigger;
      triggerRef.current = config.trigger;
      config.trigger.classList.add("context-menu-target");
      config.trigger.focus({ preventScroll: true });
      const next = { ...config, key: ++nextKey.current };
      menuRef.current = next;
      setMenu(next);
      setPos(null);
      setSubmenu(null);
      setSubPos(null);
      setCreatingTag(false);
      setNewTagName("");
    },
    [close],
  );

  useEffect(
    () => () => {
      clearHighlight();
    },
    [clearHighlight],
  );

  // Fallback for images that have no menu of their own (minimap, hover peek,
  // logos, ...). React handlers run at the root before this document listener,
  // so a handled image already has defaultPrevented set and is left alone.
  // Without it WKWebView shows the system image menu, whose "Download Image"
  // does nothing. Editable fields and selectable text keep the system menu.
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
        return;
      }
      if (!target.closest("img")) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      close(false);
    };
    const onResize = () => close(false);
    const onBlur = () => close(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (submenu) closeSubmenu(true);
      else close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [menu?.key, submenu, close, closeSubmenu]);

  useEffect(() => {
    if (!menu?.promptLoader) return;
    let alive = true;
    const key = menu.key;
    void menu
      .promptLoader()
      .then((prompt) => {
        if (!alive || !prompt?.trim()) return;
        setMenu((current) =>
          current?.key === key && !current.prompt
            ? { ...current, prompt }
            : current,
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [menu?.key]);

  useLayoutEffect(() => {
    if (!menu) return;
    const panel = panelRef.current;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    let left = menu.x;
    let top = menu.y;
    if (left + width > window.innerWidth - EDGE) left = menu.x - width;
    if (top + height > window.innerHeight - EDGE) top = menu.y - height;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
    top = Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE));
    setPos({ left, top });
    window.requestAnimationFrame(() => {
      panel.querySelector<HTMLElement>("[data-context-focus]:not(:disabled)")?.focus({
        preventScroll: true,
      });
    });
  }, [menu?.key]);

  useLayoutEffect(() => {
    if (!submenu) return;
    const panel = submenuRef.current;
    if (!panel) return;
    const row = submenu.anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    let left = row.right + SUBMENU_GAP;
    if (left + width > window.innerWidth - EDGE) {
      left = row.left - width - SUBMENU_GAP;
    }
    let top = row.top - 4;
    if (top + height > window.innerHeight - EDGE) {
      top = window.innerHeight - height - EDGE;
    }
    left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
    top = Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE));
    setSubPos({ left, top });
    if (submenu.focus) {
      window.requestAnimationFrame(() => {
        panel.querySelector<HTMLElement>("[data-context-focus]:not(:disabled)")?.focus({
          preventScroll: true,
        });
      });
    }
  }, [submenu]);

  const displaySections = useMemo(() => {
    if (!menu) return [];
    const sections = menu.sections.map((section) => [...section]);
    const quickActions = menu.quickActions ?? [];
    // A single quick action is not a row. Fold it into the first section:
    // one oversized button above the list reads as a mistake, not a shortcut.
    if (quickActions.length > 0 && quickActions.length < 2) {
      const quickActionItems: ContextMenuItem[] = quickActions.map((action) => ({
        id: action.id ?? action.label,
        label: action.label,
        icon: action.icon,
        onSelect: action.onSelect,
      }));
      if (sections.length) sections[0] = [...quickActionItems, ...sections[0]];
      else sections.push(quickActionItems);
    }
    return sections.filter((section) => section.length > 0);
  }, [menu]);

  const openSubmenu = useCallback(
    (id: string, item: ContextMenuItem, anchor: HTMLElement, focus = false) => {
      if (!item.submenu) return;
      setSubmenu({ id, item, anchor, focus });
      setSubPos(null);
      setCreatingTag(false);
      setNewTagName("");
    },
    [],
  );

  const activate = (item: ContextMenuItem, id: string, anchor: HTMLElement) => {
    if (item.disabled) return;
    if (item.submenu) {
      openSubmenu(id, item, anchor, true);
      return;
    }
    if (!item.onSelect) return;
    const action = item.onSelect;
    close(false);
    run(action);
  };

  const focusRelative = (scope: HTMLElement | null, step: number) => {
    if (!scope) return;
    const rows = [
      ...scope.querySelectorAll<HTMLElement>("[data-context-focus]:not(:disabled)"),
    ];
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = (index + step + rows.length) % rows.length;
    rows[next]?.focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inTextInput = target.matches("input, textarea, [contenteditable='true']");
    // The menu owns its keys: keep them away from page-level keyboard
    // shortcuts, including while typing in the new-tag field.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (submenu) closeSubmenu(true);
      else close(true);
      return;
    }
    if (inTextInput) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const scope = target.closest(".context-menu-submenu")
        ? submenuRef.current
        : panelRef.current;
      if (scope === panelRef.current && submenu) setSubmenu(null);
      focusRelative(scope, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      if (event.key === "ArrowLeft") {
        if (submenu) closeSubmenu(true);
        return;
      }
      if (submenu || !target.closest(".context-menu-panel")) return;
      const row = target.closest<HTMLButtonElement>("[data-context-item]");
      if (!row) return;
      const id = row.dataset.contextItem;
      if (!id) return;
      const item = displaySections.flat().find((entry) => itemId(entry) === id);
      if (item?.submenu) openSubmenu(id, item, row, true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(false);
    }
  };

  if (!menu) {
    return (
      <ContextMenuContext.Provider value={{ open, close }}>
        {children}
      </ContextMenuContext.Provider>
    );
  }

  const image = menu.images[0];
  const format = (image?.mime || "").split("/")[1]?.toUpperCase() || "—";
  const source =
    menu.sourceLabel ??
    (image?.source === "upload" ? t("tag_upload") : t("tag_generated"));
  const title =
    menu.title?.trim() ||
    menu.prompt?.trim() ||
    (image ? displayName(image, t) : t("image_menu"));
  const meta =
    menu.subtitle ??
    (image ? `${image.width}×${image.height} · ${format} · ${source}` : "");
  const previews = menu.images.slice(0, 3);
  const quickActions = menu.quickActions ?? [];
  const showQuickActions = quickActions.length >= 2;

  return (
    <ContextMenuContext.Provider value={{ open, close }}>
      {children}
      {createPortal(
        <>
          <div
            ref={panelRef}
            className="context-menu context-menu-panel menu"
            role="menu"
            aria-label={menu.ariaLabel ?? t("image_menu")}
            style={
              pos
                ? { position: "fixed", left: pos.left, top: pos.top, zIndex: FIXED_Z }
                : { position: "fixed", left: 0, top: 0, visibility: "hidden", zIndex: FIXED_Z }
            }
            onKeyDown={onMenuKeyDown}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="context-preview">
              <div className={`context-preview-stack${previews.length > 1 ? " stacked" : ""}`}>
                {previews
                  .slice()
                  .reverse()
                  .map((preview, index) => (
                    <img
                      key={`${preview.id}-${index}`}
                      src={imgThumbUrl(preview)}
                      alt=""
                      aria-hidden="true"
                    />
                  ))}
              </div>
              <div className="context-preview-text">
                <strong>{title}</strong>
                <span>{meta}</span>
              </div>
            </div>

            {showQuickActions && (
              <div className="context-quick-actions" role="group">
                {quickActions.slice(0, 4).map((action, index) => (
                  <button
                    key={action.id ?? `${action.label}-${index}`}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    data-context-focus
                    className={`context-quick-action${action.selected ? " is-selected" : ""}`}
                    aria-label={action.ariaLabel ?? action.label}
                    onClick={() => {
                      close(false);
                      run(action.onSelect);
                    }}
                  >
                    <Icon
                      name={action.icon}
                      size="md"
                      filled={action.filled}
                    />
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            )}

            {displaySections.map((section, sectionIndex) => (
              <Fragment key={sectionIndex}>
                {(showQuickActions || sectionIndex > 0) && (
                  <div className="context-menu-separator" role="separator" />
                )}
                {section.map((item) => {
                  const id = itemId(item);
                  return (
                    <button
                      key={id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(id, node);
                        else rowRefs.current.delete(id);
                      }}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      data-context-focus
                      data-context-item={id}
                      className={`context-menu-item${item.danger ? " danger" : ""}${
                        submenu?.id === id ? " submenu-open" : ""
                      }`}
                      disabled={item.disabled}
                      aria-haspopup={item.submenu ? "menu" : undefined}
                      aria-expanded={item.submenu ? submenu?.id === id : undefined}
                      onClick={() => activate(item, id, rowRefs.current.get(id)!)}
                      onPointerEnter={() => {
                        if (item.disabled) return;
                        if (item.submenu) {
                          openSubmenu(id, item, rowRefs.current.get(id)!);
                        } else if (submenu) {
                          setSubmenu(null);
                        }
                      }}
                    >
                      {item.checked ? (
                        <span className="context-check">
                          <Icon name="check" size="sm" />
                        </span>
                      ) : item.icon ? (
                        <Icon name={item.icon} size="sm" />
                      ) : (
                        <span className="context-icon-gap" />
                      )}
                      <span className="context-menu-label">{item.label}</span>
                      {item.hint !== undefined && (
                        <span className="context-menu-hint">{item.hint}</span>
                      )}
                      {item.submenu && <Icon name="next" size="sm" />}
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>

          {submenu && (
            <div
              ref={submenuRef}
              className="context-menu context-menu-submenu menu"
              role="menu"
              aria-label={submenu.item.label}
              style={
                subPos
                  ? { position: "fixed", left: subPos.left, top: subPos.top, zIndex: FIXED_Z + 1 }
                  : {
                      position: "fixed",
                      left: 0,
                      top: 0,
                      visibility: "hidden",
                      zIndex: FIXED_Z + 1,
                    }
              }
              onKeyDown={onMenuKeyDown}
              onContextMenu={(event) => event.preventDefault()}
            >
              {submenu.item.submenu?.kind === "tags" ? (
                <TagSubmenu
                  submenu={submenu.item.submenu}
                  creating={creatingTag}
                  value={newTagName}
                  setValue={setNewTagName}
                  startCreating={() => setCreatingTag(true)}
                  onToggle={(id) => {
                    close(false);
                    run(() => submenu.item.submenu!.kind === "tags"
                      ? submenu.item.submenu!.onToggle(id)
                      : undefined);
                  }}
                  finishCreating={() => {
                    const name = newTagName.trim();
                    if (!name) return;
                    close(false);
                    run(() => submenu.item.submenu!.kind === "tags"
                      ? submenu.item.submenu!.onCreate?.(name)
                      : undefined);
                  }}
                />
              ) : submenu.item.submenu?.kind === "custom" ? (
                submenu.item.submenu.render(() => close(false), submenu.focus)
              ) : submenu.item.submenu?.kind === "items" ? (
                submenu.item.submenu.items.map((item) => {
                  const id = itemId(item);
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      data-context-focus
                      className={`context-menu-item${item.danger ? " danger" : ""}`}
                      disabled={item.disabled}
                      onClick={() => {
                        if (!item.onSelect) return;
                        close(false);
                        run(item.onSelect);
                      }}
                    >
                      {item.checked ? (
                        <span className="context-check">
                          <Icon name="check" size="sm" />
                        </span>
                      ) : item.icon ? (
                        <Icon name={item.icon} size="sm" />
                      ) : (
                        <span className="context-icon-gap" />
                      )}
                      <span className="context-menu-label">{item.label}</span>
                      {item.hint !== undefined && (
                        <span className="context-menu-hint">{item.hint}</span>
                      )}
                    </button>
                  );
                })
              ) : null}
            </div>
          )}
        </>,
        document.body,
      )}
    </ContextMenuContext.Provider>
  );
}

function TagSubmenu({
  submenu,
  creating,
  value,
  setValue,
  startCreating,
  onToggle,
  finishCreating,
}: {
  submenu: ContextMenuTagSubmenu;
  creating: boolean;
  value: string;
  setValue: (value: string) => void;
  startCreating: () => void;
  onToggle: (id: number) => void;
  finishCreating: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {submenu.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemcheckbox"
          tabIndex={-1}
          data-context-focus
          className="context-menu-item context-tag-option"
          aria-checked={option.checked}
          onClick={() => onToggle(option.id)}
        >
          <span className="context-check">
            {option.checked && <Icon name="check" size="sm" />}
          </span>
          <span className="context-menu-label">{option.name}</span>
          <span className="context-menu-hint">{option.count}</span>
        </button>
      ))}
      {submenu.options.length === 0 && (
        <span className="context-tag-empty">{t("no_tags")}</span>
      )}
      {submenu.onCreate && creating ? (
        <div className="context-tag-create-row">
          <Icon name="add" size="sm" />
          <input
            autoFocus
            value={value}
            placeholder={submenu.createPlaceholder}
            aria-label={submenu.createPlaceholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                finishCreating();
              }
            }}
          />
        </div>
      ) : submenu.onCreate ? (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-context-focus
          className="context-tag-create"
          onClick={startCreating}
        >
          <Icon name="add" size="sm" />
          <span>{submenu.createLabel}</span>
        </button>
      ) : null}
    </>
  );
}
