import { type ReactNode, useState } from "react";
import { useI18n } from "../i18n";
import { formatMonthYear, indexInPinned, indexToDay, type ListUnit, type Timeline } from "../timeline";
import Icon from "./ui/Icon";
import JumpPopover from "./JumpPopover";

interface Props {
  total: number;
  index: number;
  endIndex: number;
  atTop: boolean;
  timeline: Timeline | null;
  timelineLoading: boolean;
  timelineError: string | null;
  phone: boolean;
  unit?: ListUnit;
  // Used before the timeline arrives (Library derives it from created_at).
  fallbackMonth?: string;
  newCount?: number;
  jumpOpen?: boolean;
  onJumpOpenChange?: (open: boolean) => void;
  onJump: (index: number) => void;
  onBackToTop: () => void;
  onNewClick?: () => void;
  children?: ReactNode;
}

/**
 * The shared position line above every virtual collection. It owns the jump
 * popover / phone drawer so all four lists expose exactly the same affordance.
 */
export default function PositionLine({
  total,
  index,
  endIndex,
  atTop,
  timeline,
  timelineLoading,
  timelineError,
  phone,
  unit = "images",
  fallbackMonth = "",
  newCount = 0,
  jumpOpen,
  onJumpOpenChange,
  onJump,
  onBackToTop,
  onNewClick,
  children,
}: Props) {
  const { t, lang } = useI18n();
  const [innerOpen, setInnerOpen] = useState(false);
  const open = jumpOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (jumpOpen === undefined) setInnerOpen(next);
    onJumpOpenChange?.(next);
  };
  const fmt = (n: number) => n.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  const timelineDay = timeline ? indexToDay(timeline, index) : null;
  const positionMonth = indexInPinned(timeline, index)
    ? t("pinned")
    : timelineDay
      ? formatMonthYear(timelineDay.day, lang)
      : fallbackMonth;
  const positionRange =
    total > 0
      ? t("lib_position", {
          from: fmt(index + 1),
          to: fmt(Math.max(index + 1, endIndex + 1)),
          total: fmt(total),
        })
      : "";

  if (!(total > 0 || phone)) return null;

  return (
    <>
      <div className="lib-position-row">
        {total > 0 ? (
          <JumpPopover
            phone={phone}
            open={open}
            onClose={() => setOpen(false)}
            trigger={
              <button
                type="button"
                className="lib-position"
                aria-live="off"
                aria-haspopup="dialog"
                aria-expanded={open}
                title={t("jump_to")}
                onClick={() => setOpen(!open)}
              >
                {positionMonth && <span className="lib-position-month">{positionMonth}</span>}
                <span className="lib-position-range">{positionRange}</span>
                <Icon name="chevronDown" size="sm" />
              </button>
            }
            timeline={timeline}
            loading={timelineLoading}
            error={timelineError}
            total={total}
            currentIndex={index}
            unit={unit}
            onJump={(next) => {
              onJump(next);
            }}
          />
        ) : (
          <span className="phone-position">
            {unit === "drafts"
              ? t("phone_total_drafts", { n: total })
              : unit === "records"
                ? t("phone_total_records", { n: total })
                : t("phone_total_images", { n: total })}
          </span>
        )}
        {total > 0 && !atTop && (
          <button
            type="button"
            className="lib-back-top"
            aria-label={t("lib_back_to_top")}
            title={t("lib_back_to_top")}
            onClick={onBackToTop}
          >
            <Icon name="backToTop" size="sm" />
          </button>
        )}
        {children}
      </div>
      {newCount > 0 && (
        <button
          type="button"
          className="lib-new-badge"
          onClick={onNewClick ?? onBackToTop}
        >
          <Icon name="chevronUp" size="sm" />
          {t("lib_new_n", { n: fmt(newCount) })}
        </button>
      )}
    </>
  );
}
