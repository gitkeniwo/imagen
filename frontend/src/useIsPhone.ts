import { useEffect, useState } from "react";

// Keep this in sync with the `@media (max-width: 639.98px)` block in styles.css.
// Width only: no UA / pointer / touch sniffing. A phone turned sideways is
// ≥ 640px wide and intentionally gets the desktop two-pane UI.
export const PHONE_QUERY = "(max-width: 639.98px)";

// Not `useSyncExternalStore` because matchMedia's listener API differs on older
// WebKit; the initial read still happens in the lazy state initializer.
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(PHONE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setIsPhone(mq.matches);
    setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isPhone;
}
