import { useLayoutEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";

export interface PanelTab<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  count?: number;
}

// Extra room (px) the full-label layout must gain before we switch back from
// icons, so a width sitting right on the threshold doesn't flip back and forth.
const HYSTERESIS = 16;

// Labeled tab bar for the sidebar and the fullscreen manager. It has exactly two
// looks, picked by measurement (not breakpoints, so it follows language, page
// zoom and sidebar drags): every tab with its full label, or icons only with
// the label kept on the active tab. Counts ride along with the full labels only
// while they fit too. Icon-only tabs keep the label as tooltip + accessible name.
export default function PanelTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: PanelTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plainRef = useRef<HTMLDivElement>(null);
  const countsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"full" | "icons">("full");
  // Last resort at the narrowest sidebar: even the active label does not fit.
  const [bare, setBare] = useState(false);
  const [showCounts, setShowCounts] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const plain = plainRef.current;
    const counts = countsRef.current;
    const active = activeRef.current;
    if (!root || !plain || !counts || !active) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const avail = root.clientWidth;
      if (avail <= 0) return; // hidden (display:none): keep the last state
      const needPlain = plain.scrollWidth + 6; // + the strip's own padding
      const needCounts = counts.scrollWidth + 6;
      setMode((prev) => {
        const slack = prev === "icons" ? HYSTERESIS : 0;
        return needPlain + slack <= avail ? "full" : "icons";
      });
      const needActive = active.scrollWidth + 6;
      setBare((prev) => needActive + (prev ? HYSTERESIS : 0) > avail);
      setShowCounts((prev) => needCounts + (prev ? 0 : HYSTERESIS) <= avail);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    ro.observe(plain);
    ro.observe(counts);
    ro.observe(active);
    // Web fonts finishing late change the label widths.
    void document.fonts?.ready.then(schedule);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [value, tabs.map((tab) => `${tab.label}:${tab.count ?? ""}`).join("|")]);

  const icons = mode === "icons";
  const classes = ["side-tabs", "panel-tabs", icons ? (bare ? "icons-only bare" : "icons-only") : "full-labels", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="tablist" ref={rootRef}>
      {tabs.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={tab.label}
            title={tab.label}
            className={`tab${active ? " active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            <Icon name={tab.icon} size="sm" />
            {(!icons || (active && !bare)) && <span className="tab-label">{tab.label}</span>}
            {!icons && showCounts && tab.count !== undefined && (
              <span className="tab-count">{tab.count}</span>
            )}
          </button>
        );
      })}
      {/* Hidden measuring layers: the full-label strip at natural width, without
          and with counts. They never take part in layout or the a11y tree. */}
      <div className="tabs-measure" aria-hidden="true" ref={plainRef}>
        {tabs.map((tab) => (
          <span className="tab" key={tab.id}>
            <Icon name={tab.icon} size="sm" />
            <span className="tab-label">{tab.label}</span>
          </span>
        ))}
      </div>
      <div className="tabs-measure" aria-hidden="true" ref={activeRef}>
        {tabs.map((tab) => (
          <span className="tab" key={tab.id}>
            <Icon name={tab.icon} size="sm" />
            {tab.id === value && <span className="tab-label">{tab.label}</span>}
          </span>
        ))}
      </div>
      <div className="tabs-measure" aria-hidden="true" ref={countsRef}>
        {tabs.map((tab) => (
          <span className="tab" key={tab.id}>
            <Icon name={tab.icon} size="sm" />
            <span className="tab-label">{tab.label}</span>
            {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
