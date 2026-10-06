import { useId, useRef, useState } from "react";

/**
 * Small ⓘ tooltip for glossary terms and inline help.
 * Dismissible on Esc or clicking outside; never covers labels.
 */
type InfoTipProps = {
  children: React.ReactNode;
  label?: string;
};

export function InfoTip({ children, label = "More info" }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="info-tip">
      <button
        ref={buttonRef}
        type="button"
        className="info-tip__trigger"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); buttonRef.current?.focus(); } }}
      >
        ⓘ
      </button>
      {open && (
        <span id={id} className="info-tip__bubble" role="tooltip">
          {children}
        </span>
      )}
    </span>
  );
}
