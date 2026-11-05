import { type RefObject, useLayoutEffect, useState } from "react";

// Narrowest a history card can be while its two labelled buttons and the
// five-icon tool row still fit (measured: the tool row alone needs ~160px).
export const MIN_HISTORY_CARD_WIDTH = 170;
const GRID_GAP = 10; // .hlist gap (--space-2_5)

// The chosen column count, reduced while the container is too narrow for
// cards of `minWidth` (e.g. two columns in the default-width sidebar).
export function useFitColumns(
  ref: RefObject<HTMLElement | null>,
  wanted: number,
  minWidth = MIN_HISTORY_CARD_WIDTH,
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  if (!width) return wanted;
  const fit = Math.floor((width + GRID_GAP) / (minWidth + GRID_GAP));
  return Math.max(1, Math.min(wanted, fit));
}
