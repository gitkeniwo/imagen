import { type CSSProperties, type ReactNode } from "react";
import { ImageRow, MARKER_COLORS, MarkerColor, ProviderId, TagRef, downloadName, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import Icon, { type IconName } from "./ui/Icon";
import { Button, IconButton } from "./ui/Button";
import Menu, { type MenuItem } from "./ui/Menu";
import ProviderBadge from "./ProviderBadge";
import { displayName } from "../displayName";
import { FullTextButton, PromptClamp } from "./FullText";

export const markerHex = (color: MarkerColor | null | undefined) =>
  MARKER_COLORS.find((item) => item.id === color)?.hex ?? MARKER_COLORS[0].hex;

// One-line failure reason; "Details" opens the shared full-text popover.
function ErrorLine({ kind, message }: { kind: string; message: string }) {
  const { t } = useI18n();
  return (
    <div className={`gcard-error ${kind}`}>
      <Icon name="warning" size="sm" />
      <span className="gcard-error-text" title={message}>{message}</span>
      <FullTextButton label={t("details")} title={t(`status_${kind}`)} text={message} />
    </div>
  );
}

export interface CardAction {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  // Tooltip when it says more than the label.
  title?: string;
}

export type CardMedia =
  | { kind: "image"; image: ImageRow; onOpen: () => void }
  | { kind: "pending"; active: boolean }
  | { kind: "missing" }
  | { kind: "empty" };

// Shared card for queue tasks, history records and favorites: the result on
// top (status as a badge on it), then meta, failure line, prompt, inputs and
// one action row — at most three visible actions, everything else in "⋯".
export default function GenerationCard({
  media,
  aspectRatio,
  status,
  statusLabel,
  imported,
  extraBadges,
  overlay,
  markerColor,
  header,
  provider,
  meta,
  runtime,
  substatus,
  error,
  prompt,
  promptLines,
  inputs,
  onOpenInput,
  onImageContextMenu,
  tags,
  actions,
  extra,
  menuItems,
  menuFooter,
  footerBadge,
  metaBadge,
  fixed = false,
}: {
  media: CardMedia;
  aspectRatio?: string | null;
  // Badge shown over the media; omit for a plain success.
  status?: string;
  statusLabel?: string;
  imported?: boolean;
  extraBadges?: ReactNode;
  // Top-right controls on the media (favorite …).
  overlay?: ReactNode;
  markerColor?: MarkerColor | null;
  header?: ReactNode;
  provider?: ProviderId;
  meta: (string | null | undefined)[];
  runtime?: string | null;
  substatus?: string | null;
  error?: { kind: string; message: string } | null;
  prompt?: string;
  promptLines?: number;
  inputs: ImageRow[];
  onOpenInput?: (img: ImageRow) => void;
  onImageContextMenu?: (img: ImageRow, trigger: HTMLElement, x: number, y: number) => void;
  tags?: TagRef[];
  actions: CardAction[];
  // Time-critical controls (undo send / cancel) rendered before "⋯".
  extra?: ReactNode;
  menuItems: MenuItem[];
  menuFooter?: (close: () => void) => ReactNode;
  // series-v2 B1a: series badge after the actions (Drafts) or at the end of
  // the params row (Queue). Both live in existing rows: the card never grows.
  footerBadge?: ReactNode;
  metaBadge?: ReactNode;
  // Fixed-height card for a virtual list: media and body never expand.
  fixed?: boolean;
}) {
  const { t } = useI18n();
  const ratio =
    media.kind === "image" && media.image.width && media.image.height
      ? `${media.image.width} / ${media.image.height}`
      : aspectRatio
      ? aspectRatio.replace(":", " / ")
      : "1 / 1";
  // No result to show: skip the media block; badges move into the body.
  const compactMedia =
    !fixed && (media.kind === "missing" || media.kind === "empty");
  const badges = (status || imported || extraBadges) && (
    <div className="gcard-badges">
      {status && <span className={`badge ${status}`}>{statusLabel}</span>}
      {imported && (
        <span className="badge imported">
          <Icon name="imported" size="sm" />
          {t("imported_badge")}
        </span>
      )}
      {extraBadges}
    </div>
  );
  const shownInputs = fixed ? inputs.slice(0, 3) : inputs;
  const hiddenInputs = inputs.length - shownInputs.length;
  const shownTags = fixed ? (tags ?? []).slice(0, 2) : tags ?? [];
  const hiddenTags = (tags?.length ?? 0) - shownTags.length;

  return (
    <article
      className={`gcard${markerColor ? " marked" : ""}${fixed ? " fixed" : ""}`}
      style={markerColor ? ({ "--marker-color": markerHex(markerColor) } as CSSProperties) : undefined}
    >
      {!compactMedia && (
        <div className="gcard-media" style={{ aspectRatio: ratio }}>
          {media.kind === "image" ? (
            <img
              src={imgThumbUrl(media.image)}
              alt={displayName(media.image, t)}
              title={t("open_viewer")}
              onClick={media.onOpen}
              {...pressable(
                media.onOpen,
                onImageContextMenu
                  ? (trigger, x, y) =>
                      onImageContextMenu(media.image, trigger, x, y)
                  : undefined,
              )}
            />
          ) : media.kind === "pending" ? (
            <div className={`q-shimmer${media.active ? " active" : ""}`} />
          ) : media.kind === "missing" ? (
            <span className="gcard-media-note">
              <Icon name="imageMissing" size="sm" />
              {t("deleted_label")}
            </span>
          ) : (
            <span className="gcard-media-empty" aria-hidden="true" />
          )}
          {badges}
          {overlay && <div className="gcard-overlay">{overlay}</div>}
        </div>
      )}

      <div className="gcard-body">
        {compactMedia && (
          <div className="gcard-head">
            {badges}
            {media.kind === "missing" && (
              <span className="gcard-media-note">
                <Icon name="imageMissing" size="sm" />
                {t("deleted_label")}
              </span>
            )}
            {overlay && <div className="gcard-overlay">{overlay}</div>}
          </div>
        )}
        {header}
        <div className="gcard-meta">
          {provider && <ProviderBadge provider={provider} />}
          {meta.filter(Boolean).join(" · ")}
          {runtime && <span className="gcard-runtime"> · {runtime}</span>}
          {metaBadge}
        </div>
        {substatus && <div className="q-substatus">{substatus}</div>}
        {error && <ErrorLine kind={error.kind} message={error.message} />}
        {prompt !== undefined && (
          <PromptClamp text={prompt} lines={promptLines ?? 3} />
        )}
        {(shownInputs.length > 0 || shownTags.length > 0) && (
          <div className="gcard-inputs">
            {shownInputs.map((im) =>
              im.deleted_at ? (
                <span key={im.id} className="deleted-tile" title={t("deleted_label")}>
                  <Icon name="imageMissing" />
                </span>
              ) : (
                <img
                  key={im.id}
                  src={imgThumbUrl(im)}
                  alt={displayName(im, t)}
                  title={displayName(im, t)}
                  onClick={onOpenInput ? () => onOpenInput(im) : undefined}
                  {...(onOpenInput || onImageContextMenu
                    ? pressable(
                        () => onOpenInput?.(im),
                        onImageContextMenu
                          ? (trigger, x, y) =>
                              onImageContextMenu(im, trigger, x, y)
                          : undefined,
                      )
                    : {})}
                />
              ),
            )}
            {hiddenInputs > 0 && (
              <span className="gcard-more">+{hiddenInputs}</span>
            )}
            {shownTags.map((tg) => (
              <span key={tg.id} className="card-tag">
                {tg.name}
              </span>
            ))}
            {hiddenTags > 0 && (
              <span className="gcard-more">+{hiddenTags}</span>
            )}
          </div>
        )}
        <div className="gcard-actions">
          {actions.map((a) => (
            <Button
              key={a.label}
              size="sm"
              variant={a.primary ? "primary" : "ghost"}
              icon={a.icon}
              title={a.title ?? a.label}
              aria-label={a.label}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              <span className="gcard-action-label">{a.label}</span>
            </Button>
          ))}
          {footerBadge}
          <div className="spacer" />
          {extra}
          {menuItems.length > 0 && (
            <Menu
              items={menuItems}
              footer={menuFooter}
              renderTrigger={({ open, toggle }) => (
                <IconButton icon="more" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
              )}
            />
          )}
        </div>
      </div>
    </article>
  );
}

// Marker swatches for a card's "⋯" menu footer.
export function MarkerSwatches({
  value,
  onPick,
}: {
  value: MarkerColor | null | undefined;
  onPick: (color: MarkerColor | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="menu-swatches" role="group" aria-label={t("choose_marker_color")}>
      <span className="menu-swatches-label">{t("marker_label")}</span>
      {MARKER_COLORS.map((color) => (
        <button
          key={color.id}
          type="button"
          className={value === color.id ? "selected" : ""}
          style={{ "--marker-color": color.hex } as CSSProperties}
          title={t(`marker_${color.id}`)}
          aria-label={t(`marker_${color.id}`)}
          aria-pressed={value === color.id}
          onClick={() => onPick(color.id)}
        />
      ))}
      {value && (
        <IconButton icon="close" label={t("remove_marker")} onClick={() => onPick(null)} />
      )}
    </div>
  );
}

export function downloadImage(img: ImageRow) {
  const a = document.createElement("a");
  a.href = imgFileUrl(img);
  a.download = downloadName(img);
  a.click();
}
