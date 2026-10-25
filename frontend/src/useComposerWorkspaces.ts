import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ImageRow } from "./api";
import {
  emptyWorkspace,
  loadWindowActiveId,
  loadWorkspaces,
  saveLastActiveId,
  saveWindowActiveId,
  saveWorkspace,
  sanitizeWorkspace,
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

  const selectWorkspace = useCallback(
    (id: string) => {
      if (!workspacesRef.current.some((workspace) => workspace.id === id)) return;
      setActiveId(id);
      saveWindowActiveId(libraryKey ?? "", id);
      if (libraryKey) saveLastActiveId(libraryKey, id);
    },
    [libraryKey],
  );

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
  };
}
