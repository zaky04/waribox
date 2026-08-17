import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { inputStyle } from "./sharedStyles";

export interface SearchableSelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
}

// Champ texte + suggestions filtrées en direct, pour remplacer les <select>
// natifs dès que la liste (produits, clients...) peut devenir longue.
export function SearchableSelect({ options, value, onChange, placeholder, emptyLabel }: SearchableSelectProps) {
  const { t } = useTranslation();
  const selected = options.find((o) => o.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const match = options.find((o) => o.value === value);
    setQuery(match?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || term === selected?.label.toLowerCase()) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(term) || (o.sublabel && o.sublabel.toLowerCase().includes(term)),
    );
  }, [options, query, selected]);

  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        style={inputStyle}
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (e.target.value === "") onChange("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            marginTop: 4,
            maxHeight: 240,
            overflowY: "auto",
            zIndex: 20,
          }}
        >
          {emptyLabel && (
            <div
              onMouseDown={() => {
                onChange("");
                setQuery("");
                setOpen(false);
              }}
              style={optionStyle}
            >
              {emptyLabel}
            </div>
          )}
          {filtered.map((option) => (
            <div
              key={option.value}
              onMouseDown={() => {
                onChange(option.value);
                setQuery(option.label);
                setOpen(false);
              }}
              style={optionStyle}
            >
              {option.label}
              {option.sublabel && <span style={{ color: "var(--color-text-muted)" }}> — {option.sublabel}</span>}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: "8px 12px", color: "var(--color-text-muted)" }}>{t("common.noResults")}</div>
          )}
        </div>
      )}
    </div>
  );
}

const optionStyle: CSSProperties = {
  padding: "8px 12px",
  cursor: "pointer",
  color: "var(--color-text)",
};
