import type { KeyboardEvent } from "react";

// Spread onto a clickable non-button element (e.g. a grid <img>) to make it
// keyboard-operable: focusable, announced as a button, Enter/Space activate.
export const pressable = (activate: () => void) => ({
  role: "button" as const,
  tabIndex: 0,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  },
});
