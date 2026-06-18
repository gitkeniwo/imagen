import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

const DEBOUNCE_MS = 250;

/**
 * Debounced search input shared by Library and History. Keeps its own local
 * text state for snappy typing and only emits the (trimmed-ish) query upstream
 * after a short pause, so each page can fire a backend request per settled term.
 */
export default function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);

  // Keep local text in sync when the value is reset from outside (e.g. clear filters).
  useEffect(() => {
    setText(value);
  }, [value]);

  const emit = (next: string) => {
    setText(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(next), DEBOUNCE_MS);
  };

  const clear = () => {
    window.clearTimeout(timer.current);
    setText("");
    onChange("");
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="searchbox">
      <span className="searchbox-icon" aria-hidden>
        🔍
      </span>
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => emit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            clear();
          }
        }}
      />
      {text && (
        <button
          type="button"
          className="searchbox-clear"
          title={t("clear_search")}
          onClick={clear}
        >
          ✕
        </button>
      )}
    </div>
  );
}
