// Provider catalog (GET /api/providers), loaded once for the whole app.
//
// Everything that asks "can this be generated?" or "what does this model
// accept?" reads it from here. Until the catalog arrives nothing is ready and
// no saved choice is rewritten (see fitChoice / fitSettings callers).

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  api,
  ModelSpec,
  normalizeModelId,
  ProviderId,
  ProviderInfo,
} from "./api";

export interface ProviderChoice {
  provider: ProviderId;
  model: string;
}

export interface ProvidersValue {
  providers: ProviderInfo[];
  // Enabled providers in catalog order; the first one is the fallback.
  enabled: ProviderInfo[];
  loading: boolean;
  loaded: boolean;
  // Re-fetch, or adopt a catalog a settings write already returned.
  reload: (next?: ProviderInfo[]) => Promise<void>;
  info: (provider: ProviderId) => ProviderInfo | undefined;
  spec: (provider: ProviderId, model: string) => ModelSpec | undefined;
  // Enabled and configured: a generate call would not be refused up front.
  isReady: (provider: ProviderId) => boolean;
  // null while the catalog is unknown (no "not set up" warning yet).
  anyReady: boolean | null;
  // Move a choice onto an enabled provider / a model it serves.
  fit: (choice: ProviderChoice) => ProviderChoice & { fellBack: boolean };
}

const ProvidersContext = createContext<ProvidersValue | null>(null);

/**
 * Pure fallback rule: a provider that is off (or unknown) becomes the first
 * enabled one; a model that provider doesn't serve becomes its first model.
 * `fellBack` is true only when the provider changed, which callers announce.
 */
export function fitChoice(
  enabled: ProviderInfo[],
  choice: ProviderChoice,
): ProviderChoice & { fellBack: boolean } {
  const model = normalizeModelId(choice.model);
  const target = enabled.find((p) => p.id === choice.provider) ?? enabled[0];
  if (!target) return { provider: choice.provider, model, fellBack: false };
  const spec = target.models.find((m) => m.id === model) ?? target.models[0];
  return {
    provider: target.id,
    model: spec?.id ?? model,
    fellBack: target.id !== choice.provider,
  };
}

/**
 * Coerce composer settings to what `spec` accepts. A model without
 * resolutions keeps the stored one (it is ignored on send), so switching
 * back to Pro restores it.
 */
export function fitSettings(
  spec: ModelSpec,
  s: { aspectRatio: string; resolution: string; format: string },
): { aspectRatio: string; resolution: string; format: string } {
  const pick = (list: string[], value: string, preferred: string) =>
    list.length === 0 || list.includes(value)
      ? value
      : list.includes(preferred)
        ? preferred
        : list[0];
  return {
    aspectRatio: pick(spec.aspectRatios, s.aspectRatio, "1:1"),
    resolution: pick(spec.resolutions, s.resolution, "1K"),
    format: pick(spec.outputFormats, s.format, "image/jpeg"),
  };
}

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async (next?: ProviderInfo[]) => {
    if (next) {
      setProviders(next);
      setLoaded(true);
      return;
    }
    setLoading(true);
    try {
      const res = await api.getProviders();
      setProviders(res.providers);
      setLoaded(true);
    } catch {
      // Offline / unauthorized: keep the last catalog (or none) this session.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<ProvidersValue>(() => {
    const enabled = providers.filter((p) => p.enabled);
    const info = (provider: ProviderId) => providers.find((p) => p.id === provider);
    const isReady = (provider: ProviderId) => {
      const p = info(provider);
      return !!p && p.enabled && p.configured;
    };
    return {
      providers,
      enabled,
      loading,
      loaded,
      reload,
      info,
      spec: (provider, model) =>
        info(provider)?.models.find((m) => m.id === normalizeModelId(model)),
      isReady,
      anyReady: loaded ? enabled.some((p) => p.configured) : null,
      fit: (choice) => fitChoice(enabled, choice),
    };
  }, [providers, loading, loaded, reload]);

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
}

export function useProviders(): ProvidersValue {
  const ctx = useContext(ProvidersContext);
  if (!ctx) throw new Error("useProviders must be used inside ProvidersProvider");
  return ctx;
}
