import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { Button, IconButton } from "./ui/Button";
import Popover from "./ui/Popover";
import { useToast } from "./Toast";

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
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
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
          onClick={async () =>
            toast((await copyText(text)) ? t("copied") : t("copy_failed"))
          }
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
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
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
