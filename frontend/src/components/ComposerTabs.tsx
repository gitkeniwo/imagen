import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../i18n";
import type { WorkspaceRecord } from "../composerDraft";
import Icon from "./ui/Icon";
import Menu from "./ui/Menu";
import Popover from "./ui/Popover";
import { Button } from "./ui/Button";

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
  const renameIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!renamingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renamingId]);

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
      className={`composer-tabs${phone ? " phone" : ""}${undocked ? " undocked" : ""}`}
      data-workspace-count={workspaces.length}
    >
      <div
        className="composer-tablist"
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
                        if (renamingId === workspace.id) return;
                        event.preventDefault();
                        toggle();
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
                            onClick={() => onSelect(workspace.id)}
                            onDoubleClick={() => startRename(workspace)}
                            onKeyDown={(event) => {
                              if (event.key === "F2") {
                                event.preventDefault();
                                startRename(workspace);
                              }
                            }}
                          >
                            <span className="ws-tab-name">{label}</span>
                          </button>
                          {workspaces.length > 1 && (
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
    </div>
  );
}
