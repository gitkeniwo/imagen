import { memo, type MouseEvent, type PointerEvent } from "react";
import { type ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { displayName } from "../displayName";
import { pressable } from "../a11y";
import { imageDragProps } from "../imageDrag";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/Button";
import { openContextMenuFromEvent } from "./ui/ContextMenu";
import { peekProps } from "./HoverPeek";

/**
 * Handlers shared by every tile. The Library keeps this object stable (it
 * forwards to its latest closures through a ref), so a memoized tile only
 * re-renders when its own row or flags change — not on every scroll frame.
 */
export interface LibraryTileActions {
  click(img: ImageRow, index: number, event: MouseEvent | null): void;
  menu(img: ImageRow, index: number, trigger: HTMLElement, x: number, y: number): void;
  openViewer(img: ImageRow, index: number): void;
  addRef(img: ImageRow): void;
  unpick(img: ImageRow): void;
  star(img: ImageRow): void;
  download(img: ImageRow): void;
  remove(img: ImageRow): void;
  pressStart(event: PointerEvent, img: ImageRow, index: number): void;
  pressMove(event: PointerEvent): void;
  pressEnd(): void;
}

interface Props {
  img: ImageRow;
  index: number;
  actions: LibraryTileActions;
  selected: boolean;
  selectMode: boolean;
  // Position in the picker's pick list, or -1.
  pickAt: number;
  justAdded: boolean;
  phone: boolean;
  peeks: boolean;
  picker: boolean;
}

function LibraryTile({
  img,
  index,
  actions,
  selected,
  selectMode,
  pickAt,
  justAdded,
  phone,
  peeks,
  picker,
}: Props) {
  const { t } = useI18n();
  const tagNames = (img.tags ?? []).map((tg) => tg.name);
  const picked = pickAt >= 0;
  const menu = (trigger: HTMLElement, x: number, y: number) =>
    actions.menu(img, index, trigger, x, y);
  return (
    <div
      className={`card lib-tile${selected ? " selected" : ""}${selectMode ? " selecting" : ""}${
        justAdded ? " just-added" : ""
      }${picked ? " picked" : ""}`}
      data-index={index}
      {...(!phone && !selectMode ? imageDragProps(img) : {})}
      onPointerDown={phone ? (e) => actions.pressStart(e, img, index) : undefined}
      onPointerMove={phone ? actions.pressMove : undefined}
      onPointerUp={phone ? actions.pressEnd : undefined}
      onPointerCancel={phone ? actions.pressEnd : undefined}
      onPointerLeave={phone ? actions.pressEnd : undefined}
    >
      <img
        src={imgThumbUrl(img)}
        alt={displayName(img, t)}
        draggable={false}
        decoding="async"
        title={peeks ? undefined : [displayName(img, t), ...tagNames].join(" · ")}
        onClick={(e) => actions.click(img, index, e)}
        {...pressable(() => actions.click(img, index, null), menu)}
        {...(peeks ? peekProps(img) : {})}
      />
      <span
        className={`lib-source ${img.source}`}
        title={img.source === "upload" ? t("tag_upload") : t("tag_generated")}
      >
        <Icon name={img.source === "upload" ? "uploaded" : "generated"} size="sm" />
      </span>
      {picked && !selectMode && (
        <button
          type="button"
          className="pick-badge"
          aria-label={t("picker_ref_badge", { n: pickAt + 1 })}
          title={t("remove_ref")}
          onClick={() => actions.unpick(img)}
        >
          <Icon name="check" size="sm" />
          <span>{pickAt + 1}</span>
        </button>
      )}
      {picker && phone && !selectMode && (
        <button
          type="button"
          className="pick-view"
          aria-label={t("picker_view")}
          onClick={() => actions.openViewer(img, index)}
        >
          <Icon name="zoomIn" size="sm" />
        </button>
      )}
      {!!img.starred && !selectMode && !picked && (
        <span className="lib-starred" title={t("favorite")}>
          <Icon name="favorite" size="sm" filled />
        </span>
      )}
      {selectMode && (
        <span className="select-check">{selected && <Icon name="check" size="sm" />}</span>
      )}
      {tagNames.length > 0 && (
        <div className="lib-tags">
          {tagNames.slice(0, 2).map((name) => (
            <span key={name} className="card-tag">
              {name}
            </span>
          ))}
          {tagNames.length > 2 && <span className="card-tag">+{tagNames.length - 2}</span>}
        </div>
      )}
      {!selectMode && (
        <div
          className="lib-actions"
          onContextMenu={(event) =>
            openContextMenuFromEvent(
              event,
              menu,
              event.currentTarget.parentElement?.querySelector<HTMLImageElement>("img") ??
                event.currentTarget,
            )
          }
        >
          {picked ? (
            <IconButton
              variant="overlay"
              icon="remove"
              label={t("remove_ref")}
              onClick={() => actions.unpick(img)}
            />
          ) : (
            <IconButton
              variant="overlay"
              icon="addToRefs"
              label={t("add_ref")}
              onClick={() => actions.addRef(img)}
            />
          )}
          <div className="spacer" />
          <IconButton
            variant="overlay"
            className={img.starred ? "is-starred" : ""}
            icon="favorite"
            filled={!!img.starred}
            label={img.starred ? t("unfavorite") : t("favorite")}
            aria-pressed={!!img.starred}
            onClick={() => actions.star(img)}
          />
          <IconButton
            variant="overlay"
            icon="download"
            label={t("download")}
            onClick={() => actions.download(img)}
          />
          {!picker && (
            <IconButton
              variant="overlay"
              icon="delete"
              label={t("delete")}
              onClick={() => actions.remove(img)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default memo(LibraryTile);
