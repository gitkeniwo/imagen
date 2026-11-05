import type { KeyboardEvent, MouseEvent } from "react";
import {
  openContextMenuFromEvent,
  openContextMenuFromKeyboard,
} from "./components/ui/ContextMenu";

// Spread onto a clickable non-button element (e.g. a grid <img>) to make it
// keyboard-operable: focusable, announced as a button, Enter/Space activate.
// An optional menu callback also handles right-click and Shift+F10 / Menu key.
export const pressable = (
  activate: () => void,
  openMenu?: (trigger: HTMLElement, x: number, y: number) => void,
) => ({
  role: "button" as const,
  tabIndex: 0,
  ...(openMenu
    ? {
        onContextMenu: (e: MouseEvent<HTMLElement>) =>
          openContextMenuFromEvent(e, openMenu),
      }
    : {}),
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (openMenu && openContextMenuFromKeyboard(e, openMenu)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  },
});
