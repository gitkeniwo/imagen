type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function formatGenerationDuration(
  durationMs: number | null | undefined,
  t: Translate,
): string | null {
  if (durationMs == null || !Number.isFinite(durationMs)) return null;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return t("duration_seconds", { n: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return t("duration_minutes", { m: minutes, s: seconds });
}

export function formatGenerationRetries(
  attempts: number | null | undefined,
  t: Translate,
): string | null {
  if (attempts == null || attempts <= 1) return null;
  return t("retry_count", { n: attempts - 1 });
}

export function generationRuntime(
  durationMs: number | null | undefined,
  attempts: number | null | undefined,
  t: Translate,
): string | null {
  const parts = [
    formatGenerationDuration(durationMs, t),
    formatGenerationRetries(attempts, t),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
