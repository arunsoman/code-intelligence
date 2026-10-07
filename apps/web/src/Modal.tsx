import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

/**
 * Shared modal shell.
 *
 * - Single close affordance: ✕ icon button in the top-right.
 * - Esc and clicking the backdrop dismiss.
 * - Focus trap: Tab cycles through focusable elements inside the modal.
 * - Returns focus to the element that opened the modal on close.
 * - Consistent title styling and action footer layout.
 */
type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, className = "", actions, initialFocusRef }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    const modal = modalRef.current;
    if (!modal) return;

    // Focus the requested element, or the first focusable element, or the modal itself.
    const target = initialFocusRef?.current ?? (modal.querySelector(FOCUSABLE) as HTMLElement | null);
    (target ?? modal).focus({ preventScroll: true });

    return () => {
      document.body.style.overflow = "";
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus({ preventScroll: true });
      }
    };
  }, [initialFocusRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const modal = modalRef.current;
    if (!modal) return;
    const focusables = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(isVisible) as HTMLElement[];
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onBackdropClick}>
      <div
        ref={modalRef}
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-close"
            onClick={onClose}
            aria-label={`Close ${title}`}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">{children}</div>

        {actions != null && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}
