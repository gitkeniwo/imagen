import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ImageRow, MARKER_COLORS, MarkerColor, TagRef, downloadName, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import Icon, { type IconName } from "./ui/Icon";
import { Button, IconButton } from "./ui/Button";
import Menu, { type MenuItem } from "./ui/Menu";

export const markerHex = (color: MarkerColor | null | undefined) =>
  MARKER_COLORS.find((item) => item.id === color)?.hex ?? MARKER_COLORS[0].hex;

// The one prompt-folding implementation: clamps to `lines` and only offers the
// toggle when the text actually overflows (measured, so width changes count).
export function PromptFold({ text, lines = 3 }: { text: string; lines?: number }) {
  const { t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines, expanded]);

  return (
    <div className="prompt-fold">
      <p
        ref={ref}
        className={`prompt-fold-text${expanded ? " expanded" : ""}`}
        style={{ "--prompt-lines": lines } as CSSProperties}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button type="button" className="link-btn prompt-fold-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("show_less") : t("show_more")}
        </button>
      )}
    </div>
  );
}

// One-line failure reason; "Details" reveals the full message.
function ErrorLine({ kind, message }: { kind: string; message: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className={`gcard-error ${kind}${open ? " open" : ""}`}>
      <Icon name="warning" size="sm" />
      <span className="gcard-error-text" title={open ? undefined : message}>{message}</span>
      <button type="button" className="link-btn gcard-error-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? t("hide_details") : t("details")}
      </button>
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
  meta,
  substatus,
  error,
  prompt,
  promptLines,
  inputs,
  onOpenInput,
  tags,
  actions,
  extra,
  menuItems,
  menuFooter,
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
  meta: (string | null | undefined)[];
  substatus?: string | null;
  error?: { kind: string; message: string } | null;
  prompt?: string;
  promptLines?: number;
  inputs: ImageRow[];
  onOpenInput?: (img: ImageRow) => void;
  tags?: TagRef[];
  actions: CardAction[];
  // Time-critical controls (undo send / cancel) rendered before "⋯".
  extra?: ReactNode;
  menuItems: MenuItem[];
  menuFooter?: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const ratio =
    media.kind === "image" && media.image.width && media.image.height
      ? `${media.image.width} / ${media.image.height}`
      : aspectRatio
      ? aspectRatio.replace(":", " / ")
      : "1 / 1";
  // No result to show: skip the media block; badges move into the body.
  const compactMedia = media.kind === "missing" || media.kind === "empty";
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

  return (
    <article
      className={`gcard${markerColor ? " marked" : ""}`}
      style={markerColor ? ({ "--marker-color": markerHex(markerColor) } as CSSProperties) : undefined}
    >
      {!compactMedia && (
        <div className="gcard-media" style={{ aspectRatio: ratio }}>
          {media.kind === "image" ? (
            <img
              src={imgThumbUrl(media.image)}
              alt={media.image.filename}
              title={t("open_viewer")}
              onClick={media.onOpen}
              {...pressable(media.onOpen)}
            />
          ) : (
            <div className={`q-shimmer${media.active ? " active" : ""}`} />
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
        <div className="gcard-meta">{meta.filter(Boolean).join(" · ")}</div>
        {substatus && <div className="q-substatus">{substatus}</div>}
        {error && <ErrorLine kind={error.kind} message={error.message} />}
        {prompt && <PromptFold text={prompt} lines={promptLines} />}
        {(inputs.length > 0 || (tags && tags.length > 0)) && (
          <div className="gcard-inputs">
            {inputs.map((im) =>
              im.deleted_at ? (
                <span key={im.id} className="deleted-tile" title={t("deleted_label")}>
                  <Icon name="imageMissing" />
                </span>
              ) : (
                <img
                  key={im.id}
                  src={imgThumbUrl(im)}
                  alt={im.filename}
                  title={im.filename}
                  onClick={onOpenInput ? () => onOpenInput(im) : undefined}
                  {...(onOpenInput ? pressable(() => onOpenInput(im)) : {})}
                />
              ),
            )}
            {tags?.map((tg) => (
              <span key={tg.id} className="card-tag">
                {tg.name}
              </span>
            ))}
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
