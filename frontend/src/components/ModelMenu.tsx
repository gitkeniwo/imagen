import { useEffect, useRef, useState } from "react";
import {
  ModelSpec,
  normalizeModelId,
  ProviderId,
  ProviderInfo,
} from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import Icon from "./ui/Icon";
import Popover from "./ui/Popover";
import Segmented from "./ui/Segmented";

export const shortModelLabel = (label: string) => label.replace(/\s*\(.*\)$/, "");

function modelFor(provider: ProviderInfo | undefined, model: string): ModelSpec | undefined {
  const normalized = normalizeModelId(model);
  return provider?.models.find((spec) => spec.id === normalized);
}

/**
 * Model picker for the composer and editors. With one available provider it is
 * the existing segmented control; with several it becomes one menu grouped by
 * provider, so choosing a provider and a model stays a single action.
 */
export default function ModelMenu({
  provider,
  model,
  onChange,
  providers,
}: {
  provider: ProviderId;
  model: string;
  onChange: (choice: { provider: ProviderId; model: string }) => void;
  // Editors may pass the whole catalog, including providers that are off.
  providers?: ProviderInfo[];
}) {
  const { t } = useI18n();
  const catalog = useProviders();
  const options = providers ?? catalog.enabled;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selectedProvider = options.find((p) => p.id === provider);
  const selectedSpec = modelFor(selectedProvider, model);

  useEffect(() => {
    if (!open) return;
    const selected = panelRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    const first = panelRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    (selected ?? first)?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const choose = (nextProvider: ProviderId, nextModel: string) => {
    onChange({ provider: nextProvider, model: nextModel });
    close();
  };

  if (options.length <= 1) {
    const only = options[0];
    return (
      <Segmented
        value={model}
        onChange={(next) => {
          if (only) onChange({ provider: only.id, model: next });
        }}
        options={(only?.models ?? []).map((spec) => ({
          value: spec.id,
          label: shortModelLabel(spec.label),
          title: spec.label,
        }))}
      />
    );
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [
      ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? []),
    ];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const modelLabel = shortModelLabel(
    selectedSpec?.label ?? model.replace(/-image$/, "").replace(/-preview$/, ""),
  );
  const providerShort = t(`provider_short_${provider}`);

  return (
    <Popover
      fixed
      align="start"
      className="model-menu-wrap"
      panelClassName="model-menu"
      panelProps={{
        role: "menu",
        "aria-label": t("model"),
        onKeyDown: onMenuKeyDown,
      }}
      open={open}
      onClose={close}
      trigger={
        <button
          ref={triggerRef}
          type="button"
          className={`model-menu-trigger${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <span className="model-menu-model">{modelLabel}</span>
          <span className="model-menu-provider">· {providerShort}</span>
          <Icon name="chevronDown" size="sm" className="chevron" />
        </button>
      }
    >
      <div ref={panelRef}>
        {options.map((p) => {
          const status = !p.enabled
            ? { id: "off", label: t("provider_off") }
            : p.configured
              ? { id: "ready", label: t("provider_ready") }
              : { id: "setup", label: t("provider_not_set_up") };
          return (
            <section className="model-menu-group" key={p.id}>
              <div className="model-menu-head">
                <span className={`model-menu-dot ${status.id}`} />
                <span className="model-menu-provider-name">{p.label}</span>
                <span className="model-menu-status">{status.label}</span>
              </div>
              {p.models.map((spec) => {
                const selected = p.id === provider && spec.id === normalizeModelId(model);
                return (
                  <button
                    key={`${p.id}:${spec.id}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`model-menu-item${selected ? " selected" : ""}`}
                    onClick={() => choose(p.id, spec.id)}
                  >
                    <span>{shortModelLabel(spec.label)}</span>
                    {selected && <Icon name="check" size="sm" />}
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
    </Popover>
  );
}
