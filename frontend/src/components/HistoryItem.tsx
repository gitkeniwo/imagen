import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Generation, ImageRow, TagRef, imgThumbUrl } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { peekProps } from "./HoverPeek";
import { imageDragProps } from "../imageDrag";
import { pressable } from "../a11y";
import Icon, { type IconName } from "./ui/Icon";
import { Button, IconButton } from "./ui/Button";
import Popover from "./ui/Popover";
import { useToast } from "./Toast";
import { downloadImage, markerHex } from "./GenerationCard";

export type HistoryLayout = "grid" | "list";

// Inputs shown as thumbnails on the chip row; the rest collapse into "+N".
const MAX_CHIP_INPUTS = 3;

// A small text trigger that opens a floating panel with the complete text, so
// fixed-height cards never grow (and never break row alignment) to show it.
export function FullTextButton({
  label,
  title,
  text,
  className,
}: {
  label: string;
  title: string;
  text: string;
  className?: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      fixed
      className={["fulltext-wrap", className].filter(Boolean).join(" ")}
      panelClassName="fulltext-popover"
      panelProps={{ role: "dialog", "aria-label": title }}
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button
          type="button"
          className="fulltext-trigger"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {label}
        </button>
      }
    >
      <div className="fulltext-head">
        <span className="fulltext-title">{title}</span>
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          onClick={async () => toast((await copyText(text)) ? t("copied") : t("copy_failed"))}
        >
          {t("copy")}
        </Button>
        <IconButton icon="close" label={t("close")} onClick={() => setOpen(false)} />
      </div>
      <p className="fulltext-body">{text}</p>
    </Popover>
  );
}

// Prompt clamped to a fixed number of lines; "Full text" appears only when it
// actually overflows (measured, so sidebar width changes count).
export function PromptClamp({ text, lines }: { text: string; lines: number }) {
  const { t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines]);
  return (
    <div className="hcard-prompt" style={{ "--prompt-lines": lines } as CSSProperties}>
      <p ref={ref} className={text ? "" : "hcard-prompt-empty"}>
        {text || t("no_prompt")}
      </p>
      {overflows && <FullTextButton label={t("full_text")} title={t("prompt")} text={text} />}
    </div>
  );
}

interface Tool {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

// One history record. Every slot has a fixed height, so cards in a grid row
// (and rows in the list) line up regardless of prompt length or failures.
export default function HistoryItem({
  g,
  layout,
  output,
  missing,
  onOpen,
  onToggleStar,
  onOpenInput,
  tags,
  onReuse,
  onRerun,
  onUseAsRef,
  onEdit,
  onDuplicate,
  header,
}: {
  g: Generation;
  layout: HistoryLayout;
  output: ImageRow | null;
  missing: boolean;
  onOpen: () => void;
  onToggleStar?: () => void;
  onOpenInput: (img: ImageRow) => void;
  tags: TagRef[];
  onReuse: () => void;
  onRerun?: () => void;
  onUseAsRef?: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  // Optional extra row above the meta (the favorites note).
  header?: ReactNode;
}) {
  const { t, reason } = useI18n();
  const toast = useToast();
  const running = g.status === "running";
  const failed = !output && !missing && !running;
  const kind = g.status === "blocked" || g.status === "aborted" || g.status === "note" ? g.status : "error";
  const errorText =
    g.status === "note" ? t("note_no_output") : reason(g.raw_finish) || g.error_message || t("no_output");
  const meta = [g.model.replace("-image", "").replace("-preview", ""), g.aspect_ratio, g.resolution]
    .filter(Boolean)
    .join(" · ");
  const inputs = g.inputs ?? [];

  const tools: Tool[] = [
    { icon: "addToRefs", label: t("as_ref_short"), onClick: () => onUseAsRef?.(), disabled: !output || !onUseAsRef },
    {
      icon: "copy",
      label: t("copy_prompt"),
      onClick: async () => toast((await copyText(g.prompt)) ? t("copied") : t("copy_failed")),
      disabled: !g.prompt,
    },
    { icon: "download", label: t("download"), onClick: () => output && downloadImage(output), disabled: !output },
    { icon: "edit", label: t("edit_annotation"), onClick: onEdit, disabled: running },
    { icon: "duplicate", label: t("duplicate_record"), onClick: onDuplicate, disabled: running },
  ];

  const media = (
    <div
      className={`hcard-media${failed ? ` failed ${kind}` : ""}`}
      {...(output && !output.deleted_at ? imageDragProps(output) : {})}
    >
      {output ? (
        <>
          <img
            src={imgThumbUrl(output.id)}
            alt={output.filename}
            draggable={false}
            title={t("open_viewer")}
            onClick={onOpen}
            {...pressable(onOpen)}
          />
          {onToggleStar && (
            <IconButton
              variant="overlay"
              className={`hcard-star${output.starred ? " is-starred" : ""}`}
              icon="favorite"
              filled={!!output.starred}
              label={output.starred ? t("unfavorite") : t("favorite")}
              aria-pressed={!!output.starred}
              onClick={onToggleStar}
            />
          )}
        </>
      ) : running ? (
        <div className="q-shimmer active" />
      ) : missing ? (
        <div className="hcard-status">
          <Icon name="imageMissing" />
          <span className="hcard-status-label">{t("deleted_label")}</span>
        </div>
      ) : (
        <div className="hcard-status">
          <Icon name="warning" />
          <span className="hcard-status-label">{t(`status_${g.status}`)}</span>
          {layout === "grid" ? (
            <>
              <span className="hcard-status-reason">{errorText}</span>
              <FullTextButton label={t("details")} title={t(`status_${g.status}`)} text={errorText} />
            </>
          ) : (
            <span className="hcard-status-meta">{meta}</span>
          )}
        </div>
      )}
    </div>
  );

  // In the list the failure reason takes the meta line; in the grid it lives
  // in the media slot, and the meta line always shows model · ratio · size.
  const listFailure = layout === "list" && failed;

  return (
    <article className={`hcard ${layout}`}>
      {media}
      <div className="hcard-body">
        {header}
        <div className={`hcard-meta${listFailure ? ` ${kind}` : ""}`}>
          {g.marker_color && (
            <span
              className="hcard-marker"
              style={{ background: markerHex(g.marker_color) }}
              title={t("marker_label")}
            />
          )}
          {g.source === "manual" && <span className="hcard-flag">{t("imported_badge")}</span>}
          {running && <span className="hcard-flag running">{t("status_running")}</span>}
          <span className="hcard-meta-text">{listFailure ? errorText : meta}</span>
          {listFailure && <FullTextButton label={t("details")} title={t(`status_${g.status}`)} text={errorText} />}
        </div>
        <PromptClamp text={g.prompt} lines={2} />
        <div className="hcard-chips">
          {inputs.slice(0, MAX_CHIP_INPUTS).map((im) =>
            im.deleted_at ? (
              <span key={im.id} className="deleted-tile" title={t("deleted_label")}>
                <Icon name="imageMissing" size="sm" />
              </span>
            ) : (
              <img
                key={im.id}
                src={imgThumbUrl(im.id)}
                alt={im.filename}
                {...peekProps(im, t("peek_input", { n: inputs.indexOf(im) + 1 }))}
                onClick={() => onOpenInput(im)}
                {...pressable(() => onOpenInput(im))}
              />
            ),
          )}
          {inputs.length > MAX_CHIP_INPUTS && (
            <span className="hcard-more" title={t("inputs_n", { n: inputs.length })}>
              +{inputs.length - MAX_CHIP_INPUTS}
            </span>
          )}
          {tags.length > 0 && (
            <span className="card-tag hcard-tag" title={tags.map((tg) => tg.name).join(", ")}>
              {tags[0].name}
            </span>
          )}
          {tags.length > 1 && (
            <span className="hcard-more" title={tags.map((tg) => tg.name).join(", ")}>
              +{tags.length - 1}
            </span>
          )}
        </div>
        <div className="hcard-actions">
          <Button size="sm" icon="reuse" onClick={onReuse} title={t("reuse")}>
            <span className="hcard-btn-label">{t("reuse")}</span>
          </Button>
          <Button
            size="sm"
            icon="rerun"
            onClick={() => onRerun?.()}
            disabled={!onRerun || running || g.source === "manual"}
            title={g.source === "manual" ? t("rerun_manual_hint") : t("rerun_short")}
          >
            <span className="hcard-btn-label">{t("rerun_short")}</span>
          </Button>
          <div className="hcard-tools">
            {tools.map((tool) => (
              <IconButton
                key={tool.icon}
                icon={tool.icon}
                label={tool.label}
                disabled={tool.disabled}
                onClick={tool.onClick}
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
