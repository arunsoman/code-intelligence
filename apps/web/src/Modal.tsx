import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { trapTabKey, useDialogFocus } from "./useDialogA11y.ts";

/**
 * Shared modal shell.
 *
 * - Single close affordance: ✕ icon button in the top-right.
 * - Esc and clicking the backdrop dismiss.
 * - Focus trap: Tab cycles through focusable elements inside the modal.
 * - Returns focus to the element that opened the modal on close.
 * - Consistent title styling and action footer layout.
 * - `dismissible={false}` (default true) drops all three of the above: no ✕, Esc does nothing, the
 *   backdrop does nothing. For a dialog whose job is to force a choice before the app can be used
 *   (e.g. no model configured yet) — exiting must go through the dialog's own action buttons.
 */
type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  dismissible?: boolean;
};

export function Modal({ title, onClose, children, className = "", actions, initialFocusRef, dismissible = true }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useDialogFocus(modalRef, initialFocusRef);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (dismissible) { e.preventDefault(); onClose(); }
      return;
    }
    if (modalRef.current) trapTabKey(modalRef.current, e);
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (dismissible && e.target === e.currentTarget) onClose();
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
          {dismissible && (
            <button
              type="button"
              className="icon-close"
              onClick={onClose}
              aria-label={`Close ${title}`}
              title="Close (Esc)"
            >
              ✕
            </button>
          )}
        </div>

        <div className="modal-body">{children}</div>

        {actions != null && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
