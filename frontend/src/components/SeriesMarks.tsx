import { type MouseEvent } from "react";
import type { SeriesMark } from "../api";
import { useI18n } from "../i18n";
import Icon from "./ui/Icon";

/**
 * series-v2 B6: the two series-scoped mark toggles over an output thumbnail.
 * Clicking the active mark clears it; clicking the other replaces it.
 */
export default function SeriesMarkButtons({
  mark,
  onMark,
  size = "sm",
  className,
}: {
  mark: SeriesMark | null;
  onMark: (kind: SeriesMark | null) => void;
  size?: "sm" | "lg";
  className?: string;
}) {
  const { t } = useI18n();
  const toggle = (kind: SeriesMark) => (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onMark(mark === kind ? null : kind);
  };
  return (
    <span
      className={["series-mark-buttons", size, mark ?? "", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={t("sv6_marks")}
    >
      <button
        type="button"
        className={`series-mark-btn pick${mark === "pick" ? " on" : ""}`}
        aria-label={mark === "pick" ? t("sv6_clear_pick") : t("sv6_pick")}
        aria-pressed={mark === "pick"}
        title={mark === "pick" ? t("sv6_clear_pick") : t("sv6_pick")}
        onClick={toggle("pick")}
      >
        <Icon name="favorite" size="sm" filled={mark === "pick"} />
      </button>
      <button
        type="button"
        className={`series-mark-btn reject${mark === "reject" ? " on" : ""}`}
        aria-label={mark === "reject" ? t("sv6_clear_reject") : t("sv6_reject")}
        aria-pressed={mark === "reject"}
        title={mark === "reject" ? t("sv6_clear_reject") : t("sv6_reject")}
        onClick={toggle("reject")}
      >
        <Icon name="close" size="sm" />
      </button>
    </span>
  );
}

/** The labelled Pick / Reject / Cover row in the Viewer's series block. */
export function SeriesMarkToggleRow({
  mark,
  cover,
  phone,
  onMark,
  onCover,
}: {
  mark: SeriesMark | null;
  cover: boolean;
  phone: boolean;
  onMark: (kind: SeriesMark | null) => void;
  onCover: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`series-mark-toggles${phone ? " phone" : ""}`} role="group" aria-label={t("sv6_marks")}>
      <button
        type="button"
        className={`series-mark-toggle pick${mark === "pick" ? " on" : ""}`}
        aria-pressed={mark === "pick"}
        onClick={() => onMark(mark === "pick" ? null : "pick")}
      >
        <Icon name="favorite" size="sm" filled={mark === "pick"} />
        {mark === "pick" ? t("sv6_picked") : t("sv6_pick")}
      </button>
      <button
        type="button"
        className={`series-mark-toggle reject${mark === "reject" ? " on" : ""}`}
        aria-pressed={mark === "reject"}
        onClick={() => onMark(mark === "reject" ? null : "reject")}
      >
        <Icon name="close" size="sm" />
        {mark === "reject" ? t("sv6_rejected") : t("sv6_reject")}
      </button>
      <button
        type="button"
        className={`series-mark-toggle cover${cover ? " on" : ""}`}
        aria-pressed={cover}
        disabled={mark === "reject"}
        title={mark === "reject" ? t("sv6_cover_rejected") : undefined}
        onClick={onCover}
      >
        <Icon name="cover" size="sm" filled={cover} />
        {cover ? t("sv6_cover") : t("sv6_set_cover")}
      </button>
    </div>
  );
}
