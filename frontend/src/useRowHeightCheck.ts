import { type RefObject, useEffect } from "react";

/**
 * Development-only guard: fixed-height virtual rows must agree with what was
 * laid out, or the scrollbar and anchors drift. Production stays silent.
 */
export function useRowHeightCheck({
  windowRef,
  expected,
  selector,
  version,
}: {
  windowRef: RefObject<HTMLElement | null>;
  expected: number;
  selector: string;
  version: number;
}) {
  useEffect(() => {
    if (!import.meta.env.DEV || expected <= 0) return;
    const frame = requestAnimationFrame(() => {
      const nodes = windowRef.current?.querySelectorAll<HTMLElement>(selector);
      if (!nodes?.length) return;
      const actual = nodes[0].getBoundingClientRect().height;
      if (Math.abs(actual - expected) > 1.5) {
        console.warn(
          `[virtual-list] ${selector} is ${actual.toFixed(1)}px; ` +
            `the virtual row expects ${expected.toFixed(1)}px.`,
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [expected, selector, version, windowRef]);
}
