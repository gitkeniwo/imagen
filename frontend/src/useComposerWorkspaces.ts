import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ImageRow } from "./api";
import { useI18n } from "./i18n";
import { useToast } from "./components/Toast";
import {
  deleteWorkspaceRecord,
  emptyWorkspace,
  hasLocalStorage,
  loadWindowActiveId,
  loadWorkspaces,
  nextWorkspaceNumber,
  parseComposerStorageKey,
  readStoredWorkspace,
  saveLastActiveId,
  saveWindowActiveId,
  saveWorkspace,
  sanitizeWorkspace,
  sanitizeWorkspaceName,
  updateWorkspaceIndex,
  WORKSPACE_LIMIT,
  type ComposerDraft,
  type WorkspaceRecord,
} from "./composerDraft";

// The lookup endpoint accepts at most 50 ids. Keeping this in the client also
// bounds concurrent background hydration for libraries with many workspaces.
const LOOKUP_BATCH_SIZE = 50;

function workspaceFromDraft(
  base: WorkspaceRecord,
  draft: ComposerDraft,
): WorkspaceRecord {
  return {
    ...base,
    prompt: draft.prompt,
    inputIds: [...draft.inputIds],
    model: draft.model,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    format: draft.format,
    tagIds: [...draft.tagIds],
    skipIfPrecedingSucceeds: draft.skipIfPrecedingSucceeds,
    updatedAt: draft.updatedAt,
  };
}

export function useComposerWorkspaces(libraryKey: string | null) {
  const { t } = useI18n();
  const toast = useToast();
  const memoryWorkspace = useRef(emptyWorkspace(1));
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([
    memoryWorkspace.current,
  ]);
  const [activeId, setActiveId] = useState(memoryWorkspace.current.id);
  const [hydrated, setHydrated] = useState(false);
  const [, setCacheVersion] = useState(0);
  const imageCache = useRef(new Map<number, ImageRow>());
  const composerTouched = useRef(false);
  const workspacesRef = useRef(workspaces);
  const activeIdRef = useRef(activeId);
  const hydratedRef = useRef(hydrated);
  const lastSaved = useRef(new Map<string, string>());
  const lookupsInFlight = useRef(new Set<string>());
  const storageAvailable = useRef(hasLocalStorage());

  workspacesRef.current = workspaces;
  activeIdRef.current = activeId;
  hydratedRef.current = hydrated;

  const active =
    workspaces.find((workspace) => workspace.id === activeId) ?? workspaces[0];

  const tray = useMemo(
    () =>
      active
        ? active.inputIds
            .map((id) => imageCache.current.get(id))
            .filter((image): image is ImageRow => !!image)
        : [],
    // The cache is a ref; this version bump is what invalidates the view.
    [active, setCacheVersion],
  );

  const bumpCache = useCallback(() => setCacheVersion((version) => version + 1), []);

  const cacheImages = useCallback(
    (images: ImageRow[]) => {
      for (const image of images) imageCache.current.set(image.id, image);
      bumpCache();
    },
    [bumpCache],
  );

  const updateWorkspace = useCallback(
    (id: string, update: (workspace: WorkspaceRecord) => WorkspaceRecord) => {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === id ? update(workspace) : workspace,
        ),
      );
    },
    [],
  );

  const updateDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      composerTouched.current = true;
      const id = activeIdRef.current;
      updateWorkspace(id, (workspace) => ({
        ...workspace,
        ...patch,
        id: workspace.id,
        updatedAt: Date.now(),
      }));
    },
    [updateWorkspace],
  );

  const visibleInputIds = useCallback(
    () =>
      (workspacesRef.current.find(
        (workspace) => workspace.id === activeIdRef.current,
      )?.inputIds ?? []).filter((id) => imageCache.current.has(id)),
    [],
  );

  const setInputIds = useCallback(
    (ids: number[], markTouched = true) => {
      if (markTouched) composerTouched.current = true;
      const id = activeIdRef.current;
      updateWorkspace(id, (workspace) => ({
        ...workspace,
        inputIds: [...new Set(ids)],
        updatedAt: Date.now(),
      }));
    },
    [updateWorkspace],
  );

  const addManyToTray = useCallback(
    (images: ImageRow[]) => {
      cacheImages(images);
      // Starting from the visible ids drops references whose lookup failed.
      const ids = visibleInputIds();
      const seen = new Set(ids);
      for (const image of images) {
        if (!seen.has(image.id)) {
          seen.add(image.id);
          ids.push(image.id);
        }
      }
      setInputIds(ids);
    },
    [cacheImages, setInputIds, visibleInputIds],
  );

  const addToTray = useCallback(
    (image: ImageRow) => addManyToTray([image]),
    [addManyToTray],
  );

  const removeFromTray = useCallback(
    (id: number) => {
      setInputIds(visibleInputIds().filter((item) => item !== id));
    },
    [setInputIds, visibleInputIds],
  );

  const moveInTray = useCallback(
    (from: number, to: number) => {
      const ids = visibleInputIds();
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return;
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      setInputIds(ids);
    },
    [setInputIds, visibleInputIds],
  );

  const replaceReferences = useCallback(
    (images: ImageRow[]) => {
      cacheImages(images);
      setInputIds(images.map((image) => image.id));
    },
    [cacheImages, setInputIds],
  );

  const clearComposer = useCallback(() => {
    composerTouched.current = true;
    const id = activeIdRef.current;
    updateWorkspace(id, (workspace) => ({
      ...workspace,
      prompt: "",
      inputIds: [],
      updatedAt: Date.now(),
    }));
  }, [updateWorkspace]);

  const lookupReferences = useCallback(
    async (workspaceId: string, requestedIds: number[]) => {
      if (requestedIds.length === 0) return;
      const signature = `${workspaceId}:${requestedIds.join(",")}`;
      if (lookupsInFlight.current.has(signature)) return;
      lookupsInFlight.current.add(signature);
      const requested = new Set(requestedIds);
      try {
        const { images } = await api.lookupImages(requestedIds);
        cacheImages(images);
        const alive = new Set(images.map((image) => image.id));
        setWorkspaces((current) =>
          current.map((workspace) => {
            if (workspace.id !== workspaceId) return workspace;
            const inputIds = workspace.inputIds.filter(
              (id) => !requested.has(id) || alive.has(id),
            );
            return inputIds.length === workspace.inputIds.length
              ? workspace
              : { ...workspace, inputIds };
          }),
        );
      } catch {
        // Offline / unauthorized: keep the ids but show only cached images.
      } finally {
        lookupsInFlight.current.delete(signature);
      }
    },
    [cacheImages],
  );

  // Load once the library key is available. The current workspace resolves
  // first; the rest are warmed in the background for instant tab switches.
  useEffect(() => {
    if (!libraryKey) {
      setHydrated(false);
      return;
    }
    let cancelled = false;

    const hydrate = async () => {
      const loaded = loadWorkspaces(libraryKey);
      const windowId = loadWindowActiveId(libraryKey);
      const chosen =
        loaded.workspaces.find((workspace) => workspace.id === windowId) ??
        loaded.workspaces.find((workspace) => workspace.id === loaded.lastId) ??
        loaded.workspaces[0];

      let initialWorkspaces = loaded.workspaces;
      let current = chosen;
      if (composerTouched.current) {
        const latest =
          workspacesRef.current.find(
            (workspace) => workspace.id === activeIdRef.current,
          ) ?? workspacesRef.current[0];
        if (latest) {
          current = workspaceFromDraft(chosen, latest);
          initialWorkspaces = loaded.workspaces.map((workspace) =>
            workspace.id === chosen.id ? current : workspace,
          );
        }
      }

      let tags: { id: number }[] | null = null;
      try {
        tags = (await api.listTags()).tags;
      } catch {
        // Keep saved tags when the list is unavailable.
      }
      if (tags) {
        const alive = new Set(tags.map((tag) => tag.id));
        initialWorkspaces = initialWorkspaces.map((workspace) => ({
          ...workspace,
          tagIds: workspace.tagIds.filter((id) => alive.has(id)),
        }));
        current =
          initialWorkspaces.find((workspace) => workspace.id === current.id) ??
          current;
      }

      const requestedIds = [...current.inputIds];
      if (requestedIds.length > 0) {
        lookupsInFlight.current.add(`${current.id}:${requestedIds.join(",")}`);
        try {
          const { images } = await api.lookupImages(requestedIds);
          cacheImages(images);
          const alive = new Set(images.map((image) => image.id));
          current = {
            ...current,
            inputIds: composerTouched.current
              ? current.inputIds
              : current.inputIds.filter((id) => alive.has(id)),
          };
          initialWorkspaces = initialWorkspaces.map((workspace) =>
            workspace.id === current.id ? current : workspace,
          );
        } catch {
          // Keep ids; the empty tray is temporary.
        } finally {
          lookupsInFlight.current.delete(`${current.id}:${requestedIds.join(",")}`);
        }
      }

      if (cancelled) return;
      if (composerTouched.current) {
        // Apply the newest local edits if typing continued during hydration.
        const latest =
          workspacesRef.current.find(
            (workspace) => workspace.id === activeIdRef.current,
          ) ?? workspacesRef.current[0];
        if (latest) {
          current = workspaceFromDraft(current, latest);
          initialWorkspaces = initialWorkspaces.map((workspace) =>
            workspace.id === current.id ? current : workspace,
          );
        }
      }

      setWorkspaces(initialWorkspaces);
      setActiveId(current.id);
      saveWindowActiveId(libraryKey, current.id);
      saveLastActiveId(libraryKey, current.id);
      setHydrated(true);

      // Warm the other workspaces in small batches without blocking the UI.
      for (const workspace of initialWorkspaces) {
        if (cancelled) return;
        if (workspace.id === current.id || workspace.inputIds.length === 0) continue;
        for (let index = 0; index < workspace.inputIds.length; index += LOOKUP_BATCH_SIZE) {
          const ids = workspace.inputIds.slice(index, index + LOOKUP_BATCH_SIZE);
          await lookupReferences(workspace.id, ids);
        }
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [libraryKey, cacheImages, lookupReferences]);

  // A workspace switched to before its background lookup finished resolves
  // immediately instead of waiting for the warm-up loop to reach it.
  useEffect(() => {
    if (!hydrated || !active || active.inputIds.length === 0) return;
    const unresolved = active.inputIds.filter(
      (id) => !imageCache.current.has(id),
    );
    if (unresolved.length === 0) return;
    for (let index = 0; index < unresolved.length; index += LOOKUP_BATCH_SIZE) {
      void lookupReferences(
        active.id,
        unresolved.slice(index, index + LOOKUP_BATCH_SIZE),
      );
    }
  }, [active, hydrated, lookupReferences]);

  // Write-through: one record per workspace, with no debounce so closing the
  // window right after a keypress cannot drop the last characters.
  useEffect(() => {
    if (!hydrated || !libraryKey || !active) return;
    const cleaned = sanitizeWorkspace(active);
    const serialized = JSON.stringify(cleaned);
    const saved = lastSaved.current.get(cleaned.id);
    if (saved !== serialized) {
      saveWorkspace(libraryKey, cleaned);
      lastSaved.current.set(cleaned.id, serialized);
    }
    saveLastActiveId(libraryKey, cleaned.id);
    saveWindowActiveId(libraryKey, cleaned.id);
  }, [active, hydrated, libraryKey]);

  const activateWorkspace = useCallback(
    (id: string) => {
      setActiveId(id);
      if (libraryKey) saveWindowActiveId(libraryKey, id);
      if (libraryKey) saveLastActiveId(libraryKey, id);
    },
    [libraryKey],
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      if (!workspacesRef.current.some((workspace) => workspace.id === id)) return;
      activateWorkspace(id);
    },
    [activateWorkspace],
  );

  const structureSnapshot = useCallback(() => {
    const current = workspacesRef.current;
    if (!libraryKey || !storageAvailable.current) return current;
    const active = current.find(
      (workspace) => workspace.id === activeIdRef.current,
    );
    if (active) saveWorkspace(libraryKey, active);
    return loadWorkspaces(libraryKey).workspaces;
  }, [libraryKey]);

  const applyStructure = useCallback(
    (next: WorkspaceRecord[], activeAfter: string) => {
      setWorkspaces(next);
      workspacesRef.current = next;
      activateWorkspace(activeAfter);
    },
    [activateWorkspace],
  );

  const createWorkspace = useCallback((): boolean => {
    const snapshot = structureSnapshot();
    if (snapshot.length >= WORKSPACE_LIMIT) return false;
    const source =
      workspacesRef.current.find(
        (workspace) => workspace.id === activeIdRef.current,
      ) ?? snapshot[0];
    if (!source) return false;

    const workspace = emptyWorkspace(
      nextWorkspaceNumber(snapshot),
      source,
    );
    const sourceAt = snapshot.findIndex((item) => item.id === source.id);
    const next = [...snapshot];
    next.splice(sourceAt >= 0 ? sourceAt + 1 : next.length, 0, workspace);

    if (libraryKey && storageAvailable.current) {
      saveWorkspace(libraryKey, workspace);
      updateWorkspaceIndex(libraryKey, (order) => {
        const copy = [...order];
        const at = sourceAt >= 0 ? copy.indexOf(source.id) : -1;
        copy.splice(at >= 0 ? at + 1 : copy.length, 0, workspace.id);
        return copy;
      });
    }
    lastSaved.current.set(workspace.id, JSON.stringify(workspace));
    applyStructure(next, workspace.id);
    return true;
  }, [applyStructure, libraryKey, structureSnapshot]);

  const duplicateWorkspace = useCallback((id: string): boolean => {
    const snapshot = structureSnapshot();
    if (snapshot.length >= WORKSPACE_LIMIT) return false;
    const source =
      workspacesRef.current.find(
        (workspace) => workspace.id === id,
      ) ??
      workspacesRef.current.find(
        (workspace) => workspace.id === activeIdRef.current,
      ) ??
      snapshot[0];
    if (!source) return false;

    const copy = emptyWorkspace(nextWorkspaceNumber(snapshot), source);
    const workspace: WorkspaceRecord = {
      ...copy,
      prompt: source.prompt,
      inputIds: [...source.inputIds],
      tagIds: [...source.tagIds],
      updatedAt: Date.now(),
      name: null,
    };
    const sourceAt = snapshot.findIndex((item) => item.id === source.id);
    const next = [...snapshot];
    next.splice(sourceAt >= 0 ? sourceAt + 1 : next.length, 0, workspace);

    if (libraryKey && storageAvailable.current) {
      saveWorkspace(libraryKey, workspace);
      updateWorkspaceIndex(libraryKey, (order) => {
        const current = [...order];
        const at = sourceAt >= 0 ? current.indexOf(source.id) : -1;
        current.splice(at >= 0 ? at + 1 : current.length, 0, workspace.id);
        return current;
      });
    }
    lastSaved.current.set(workspace.id, JSON.stringify(workspace));
    applyStructure(next, workspace.id);
    return true;
  }, [applyStructure, libraryKey, structureSnapshot]);

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      const cleaned = sanitizeWorkspaceName(name);
      updateWorkspace(id, (workspace) => ({
        ...workspace,
        name: cleaned,
        updatedAt: Date.now(),
      }));
    },
    [updateWorkspace],
  );

  const closeWorkspace = useCallback(
    (id: string): boolean => {
      const current = workspacesRef.current;
      if (current.length <= 1) return false;
      const at = current.findIndex((workspace) => workspace.id === id);
      if (at === -1) return false;
      const fallback = current[at + 1] ?? current[at - 1];
      let next = current.filter((workspace) => workspace.id !== id);

      if (libraryKey && storageAvailable.current) {
        deleteWorkspaceRecord(libraryKey, id);
        updateWorkspaceIndex(libraryKey, (order) =>
          order.filter((item) => item !== id),
        );
        const loaded = loadWorkspaces(libraryKey).workspaces;
        if (loaded.length > 0) next = loaded;
      }
      lastSaved.current.delete(id);

      let activeAfter = activeIdRef.current;
      if (activeAfter === id) {
        const preferred = next.find((workspace) => workspace.id === fallback.id);
        activeAfter = preferred?.id ?? next[Math.min(at, next.length - 1)].id;
      }
      applyStructure(next, activeAfter);
      return true;
    },
    [applyStructure, libraryKey],
  );

  // Merge index/record changes from other windows. Prompt focus is the only
  // conflict rule: a focused editor keeps its text and wins on the next write.
  useEffect(() => {
    if (!libraryKey) return;
    const promptFocused = () => {
      const element = document.activeElement;
      return (
        element instanceof HTMLElement &&
        element.classList.contains("composer-prompt")
      );
    };

    const onStorage = (event: StorageEvent) => {
      const entry = parseComposerStorageKey(libraryKey, event.key);
      if (!entry || entry.kind === "last" || entry.kind === "active") return;

      if (entry.kind === "index" || event.key === null) {
        const loaded = loadWorkspaces(libraryKey).workspaces;
        const previous = workspacesRef.current;
        const previousActive = activeIdRef.current;
        const activeStillExists = loaded.some(
          (workspace) => workspace.id === previousActive,
        );
        const previousActiveAt = previous.findIndex(
          (workspace) => workspace.id === previousActive,
        );
        const merged = loaded.map((remote) => {
          if (remote.id === previousActive && activeStillExists) {
            return previous.find((workspace) => workspace.id === remote.id) ?? remote;
          }
          return remote;
        });
        if (JSON.stringify(merged) !== JSON.stringify(previous)) {
          setWorkspaces(merged);
          workspacesRef.current = merged;
        }
        for (const workspace of loaded) {
          lastSaved.current.set(workspace.id, JSON.stringify(workspace));
        }
        if (!activeStillExists && loaded.length > 0) {
          const next =
            loaded[Math.min(Math.max(previousActiveAt, 0), loaded.length - 1)];
          activateWorkspace(next.id);
          toast(t("ws_closed_elsewhere"), "info");
        }
        return;
      }

      const remote = readStoredWorkspace(libraryKey, entry.id);
      if (!remote) return;
      const current = workspacesRef.current.find(
        (workspace) => workspace.id === entry.id,
      );
      if (!current) return;
      let next = remote;
      if (entry.id === activeIdRef.current && promptFocused()) {
        next = {
          ...current,
          number: remote.number,
          name: remote.name,
        };
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      lastSaved.current.set(remote.id, JSON.stringify(remote));
      setWorkspaces((all) =>
        all.map((workspace) =>
          workspace.id === remote.id ? next : workspace,
        ),
      );
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [activateWorkspace, libraryKey, t, toast]);

  return {
    workspaces,
    activeId,
    active,
    draft: active,
    tray,
    hydrated,
    updateDraft,
    clearComposer,
    addToTray,
    addManyToTray,
    removeFromTray,
    moveInTray,
    replaceReferences,
    selectWorkspace,
    createWorkspace,
    duplicateWorkspace,
    renameWorkspace,
    closeWorkspace,
    workspaceLimit: WORKSPACE_LIMIT,
  };
}
