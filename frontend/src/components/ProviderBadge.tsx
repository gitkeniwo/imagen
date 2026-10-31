import { ProviderId } from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";

/**
 * Provider labels only appear when they add information: more than one
 * provider is enabled, or the record came from a non-default provider.
 */
export default function ProviderBadge({
  provider,
}: {
  provider: ProviderId;
}) {
  const { t } = useI18n();
  const { enabled } = useProviders();
  if (enabled.length < 2 && provider === "vertex") return null;
  return (
    <span className="provider-badge">
      {t(`provider_short_${provider}`)}
    </span>
  );
}
