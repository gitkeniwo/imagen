import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "../i18n";
import type { WorkspaceRecord } from "../composerDraft";
import Icon from "./ui/Icon";
import Menu from "./ui/Menu";
import Popover from "./ui/Popover";
import { Button } from "./ui/Button";
import Sheet from "./ui/Sheet";
import { useBackLayer } from "../backStack";
import { seenLabel } from "./RemoteIndicator";

function workspaceTone(workspace: WorkspaceRecord): string {
  const empty = workspace.prompt.trim() === "" && workspace.inputIds.length === 0;
  return empty ? " empty" : "";
}

export default function ComposerTabs({
  workspaces,
  activeId,
  limit,
  undocked,
  phone = false,
  onSelect,
  onCreate,
  onDuplicate,
  onRename,
  onClose,
}: {
  workspaces: WorkspaceRecord[];
  activeId: string;
  limit: number;
  undocked: boolean;
  phone?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => boolean;
  onDuplicate: (id: string) => boolean;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => boolean;
}) {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [phoneEditorId, setPhoneEditorId] = useState<string | null>(null);
  const [phoneName, setPhoneName] = useState("");
  const [phoneConfirmClose, setPhoneConfirmClose] = useState(false);
  const renameIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tablistRef = useRef<HTMLDivElement>(null);
  const longPress = useRef<{
    timer: number;
    x: number;
    y: number;
    fired: boolean;
  } | null>(null);
  const suppressClickUntil = useRef(0);

  useEffect(() => {
    if (!renamingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renamingId]);

  const scrollActiveIntoView = useCallback(() => {
    const list = tablistRef.current;
    const tab = tabRefs.current.get(activeId);
    const item = tab?.closest<HTMLElement>(".ws-tab-wrap");
    if (!list || !item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - itemRect.left;
    } else if (itemRect.right > listRect.right) {
      list.scrollLeft += itemRect.right - listRect.right;
    }
  }, [activeId]);

  const measureOverflow = useCallback(() => {
    const list = tablistRef.current;
    if (!list) return;
    setOverflowing(list.scrollWidth > list.clientWidth + 1);
    window.requestAnimationFrame(scrollActiveIntoView);
  }, [scrollActiveIntoView]);

  useEffect(() => {
    const list = tablistRef.current;
    if (!list) return;
    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(list);
    window.addEventListener("resize", measureOverflow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow, workspaces]);

  useEffect(() => {
    scrollActiveIntoView();
  }, [activeId, overflowing, scrollActiveIntoView]);

  const startRename = (workspace: WorkspaceRecord) => {
    renameIdRef.current = workspace.id;
    setNameValue(workspace.name ?? "");
    setRenamingId(workspace.id);
  };

  const finishRename = (save: boolean) => {
    const id = renameIdRef.current;
    if (!id) return;
    renameIdRef.current = null;
    setRenamingId(null);
    if (save) onRename(id, nameValue);
  };

  const requestClose = (workspace: WorkspaceRecord) => {
    if (workspaces.length <= 1) return;
    if (workspace.prompt.trim() || workspace.inputIds.length > 0) {
      setConfirmId(workspace.id);
      return;
    }
    onClose(workspace.id);
  };

  const openPhoneEditor = (workspace: WorkspaceRecord) => {
    setPhoneName(workspace.name ?? "");
    setPhoneConfirmClose(false);
    setPhoneEditorId(workspace.id);
  };

  const clearLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
  };

  const onPhonePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    workspace: WorkspaceRecord,
  ) => {
    if (!phone || event.button !== 0) return;
    clearLongPress();
    const entry = {
      timer: window.setTimeout(() => {
        if (!longPress.current) return;
        longPress.current.fired = true;
        suppressClickUntil.current = Date.now() + 700;
        openPhoneEditor(workspace);
      }, 500),
      x: event.clientX,
      y: event.clientY,
      fired: false,
    };
    longPress.current = entry;
  };

  const onPhonePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const entry = longPress.current;
    if (!entry || entry.fired) return;
    if (
      Math.abs(event.clientX - entry.x) > 8 ||
      Math.abs(event.clientY - entry.y) > 8
    ) {
      clearLongPress();
      longPress.current = null;
    }
  };

  const phoneWorkspace = workspaces.find(
    (workspace) => workspace.id === phoneEditorId,
  );

  useBackLayer(phoneEditorId !== null, () => {
    setPhoneEditorId(null);
    return true;
  });

  useEffect(() => {
    if (phoneEditorId && !phoneWorkspace) setPhoneEditorId(null);
  }, [phoneEditorId, phoneWorkspace]);

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renamingId) return;
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = workspaces.findIndex((workspace) => workspace.id === activeId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? workspaces.length - 1
          : event.key === "ArrowLeft"
            ? (index - 1 + workspaces.length) % workspaces.length
            : (index + 1) % workspaces.length;
    const next = workspaces[nextIndex];
    if (!next) return;
    onSelect(next.id);
    window.requestAnimationFrame(() => tabRefs.current.get(next.id)?.focus());
  };

  const confirmWorkspace = workspaces.find(
    (workspace) => workspace.id === confirmId,
  );

  return (
    <div
      className={`composer-tabs${phone ? " phone" : ""}${undocked ? " undocked" : ""}${overflowing ? " has-overflow" : ""}`}
      data-workspace-count={workspaces.length}
    >
      <div
        className="composer-tablist"
        ref={tablistRef}
        role="tablist"
        aria-label={t("ws_tablist")}
        aria-orientation="horizontal"
        onKeyDown={onTablistKeyDown}
      >
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeId;
          const label = workspace.name ?? String(workspace.number);
          const aria = workspace.name
            ? `${t("ws_label", { n: workspace.number })}: ${workspace.name}`
            : t("ws_label", { n: workspace.number });
          return (
            <Popover
              key={workspace.id}
              fixed
              align="start"
              open={confirmId === workspace.id}
              onClose={() => setConfirmId(null)}
              panelClassName="confirm-bubble ws-confirm"
              panelProps={{
                role: "dialog",
                "aria-label": t("ws_close_confirm"),
              }}
              trigger={
                <Menu
                  align="start"
                  items={[
                    {
                      label: t("ws_rename"),
                      icon: "edit",
                      onSelect: () => startRename(workspace),
                    },
                    {
                      label: t("ws_duplicate"),
                      icon: "duplicate",
                      disabled: workspaces.length >= limit,
                      onSelect: () => onDuplicate(workspace.id),
                    },
                    {
                      label: t("ws_close"),
                      icon: "close",
                      danger: true,
                      disabled: workspaces.length <= 1,
                      onSelect: () => requestClose(workspace),
                    },
                  ]}
                  renderTrigger={({ open, toggle }) => (
                    <div
                      className={`ws-tab-wrap${isActive ? " active" : ""}${workspaceTone(workspace)}`}
                      onContextMenu={(event) => {
                        if (phone) {
                          event.preventDefault();
                          return;
                        }
                        if (renamingId === workspace.id) return;
                        event.preventDefault();
                        toggle();
                      }}
                      onPointerDown={(event) =>
                        onPhonePointerDown(event, workspace)
                      }
                      onPointerMove={onPhonePointerMove}
                      onPointerUp={() => {
                        clearLongPress();
                        longPress.current = null;
                      }}
                      onPointerCancel={() => {
                        clearLongPress();
                        longPress.current = null;
                      }}
                      onPointerLeave={() => {
                        clearLongPress();
                        longPress.current = null;
                      }}
                    >
                      {renamingId === workspace.id ? (
                        <input
                          ref={inputRef}
                          className="ws-tab-input"
                          aria-label={t("ws_rename")}
                          value={nameValue}
                          placeholder={String(workspace.number)}
                          maxLength={40}
                          onChange={(event) => setNameValue(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              finishRename(true);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              finishRename(false);
                            }
                          }}
                          onBlur={() => finishRename(true)}
                        />
                      ) : (
                        <>
                          <button
                            ref={(element) => {
                              if (element) tabRefs.current.set(workspace.id, element);
                              else tabRefs.current.delete(workspace.id);
                            }}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            aria-label={aria}
                            title={workspace.name ?? aria}
                            tabIndex={isActive ? 0 : -1}
                            className="ws-tab"
                            onClick={() => {
                              if (Date.now() < suppressClickUntil.current) {
                                suppressClickUntil.current = 0;
                                return;
                              }
                              onSelect(workspace.id);
                            }}
                            onDoubleClick={() => {
                              if (!phone) startRename(workspace);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "F2") {
                                event.preventDefault();
                                startRename(workspace);
                              }
                            }}
                          >
                            <span className="ws-tab-name">{label}</span>
                          </button>
                          {!phone && workspaces.length > 1 && (
                            <button
                              type="button"
                              className="ws-tab-close"
                              aria-label={t("ws_close")}
                              title={t("ws_close")}
                              aria-expanded={open}
                              onClick={(event) => {
                                event.stopPropagation();
                                requestClose(workspace);
                              }}
                            >
                              <Icon name="close" size="sm" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                />
              }
            >
              <p>{t("ws_close_confirm")}</p>
              <div className="confirm-bubble-actions">
                <Button size="sm" onClick={() => setConfirmId(null)}>
                  {t("cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (!confirmWorkspace) return;
                    setConfirmId(null);
                    onClose(confirmWorkspace.id);
                  }}
                >
                  {t("ws_close")}
                </Button>
              </div>
            </Popover>
          );
        })}
      </div>
      {overflowing && !phone && (
        <Menu
          align="end"
          items={workspaces.map((workspace) => ({
            label: workspace.name ?? String(workspace.number),
            hint: workspace.id === activeId ? "•" : undefined,
            onSelect: () => onSelect(workspace.id),
          }))}
          renderTrigger={({ open, toggle }) => (
            <button
              type="button"
              className="ws-overflow"
              aria-label={`${t("ws_all")} (${workspaces.length})`}
              title={t("ws_all")}
              aria-expanded={open}
              onClick={toggle}
            >
              <span>{workspaces.length}</span>
              <Icon name="chevronDown" size="sm" />
            </button>
          )}
        />
      )}
      <button
        type="button"
        className="ws-new"
        aria-label={t("ws_new")}
        title={workspaces.length >= limit ? t("ws_new_limit") : t("ws_new")}
        disabled={workspaces.length >= limit}
        onClick={() => onCreate()}
      >
        <Icon name="add" size="sm" />
      </button>
      {renamingId && (
        <div className="ws-rename-hint" role="note">
          {t("ws_rename_hint")}
        </div>
      )}
      {phone && phoneWorkspace && (
        <Sheet
          title={
            phoneWorkspace.name ??
            t("ws_label", { n: phoneWorkspace.number })
          }
          onClose={() => setPhoneEditorId(null)}
          footer={
            <div className="ws-sheet-foot">
              <Button onClick={() => setPhoneEditorId(null)}>
                {t("cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onRename(phoneWorkspace.id, phoneName);
                  setPhoneEditorId(null);
                }}
              >
                {t("save")}
              </Button>
            </div>
          }
        >
          <div className="ws-sheet-sub">
            {t("ws_meta", {
              count: phoneWorkspace.inputIds.length,
              ago: seenLabel(t, phoneWorkspace.updatedAt / 1000),
            })}
          </div>
          <label className="sheet-field">
            <span className="lab">{t("ws_name")}</span>
            <input
              value={phoneName}
              placeholder={String(phoneWorkspace.number)}
              maxLength={40}
              onChange={(event) => setPhoneName(event.target.value)}
            />
          </label>
          <p className="ws-sheet-hint">{t("ws_rename_hint")}</p>
          <div className="ws-sheet-actions">
            <button
              type="button"
              disabled={workspaces.length >= limit}
              onClick={() => {
                if (onDuplicate(phoneWorkspace.id)) setPhoneEditorId(null);
              }}
            >
              <Icon name="duplicate" size="sm" />
              {t("ws_duplicate")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={workspaces.length <= 1}
              onClick={() => {
                if (phoneWorkspace.prompt.trim() || phoneWorkspace.inputIds.length) {
                  setPhoneConfirmClose(true);
                } else {
                  onClose(phoneWorkspace.id);
                  setPhoneEditorId(null);
                }
              }}
            >
              <Icon name="close" size="sm" />
              {t("ws_close")}
            </button>
          </div>
          {phoneConfirmClose && (
            <div className="ws-sheet-confirm">
              <p>{t("ws_close_confirm")}</p>
              <div className="confirm-bubble-actions">
                <Button size="sm" onClick={() => setPhoneConfirmClose(false)}>
                  {t("cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    onClose(phoneWorkspace.id);
                    setPhoneEditorId(null);
                  }}
                >
                  {t("ws_close")}
                </Button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}
