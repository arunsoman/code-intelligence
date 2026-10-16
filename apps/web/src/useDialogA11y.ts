import { useEffect, type KeyboardEvent, type RefObject } from "react";

/**
 * The focus lifecycle every full-screen or modal dialog needs, factored out of Modal.tsx so panels with their
 * own specialized layout (independently-scrolling header/toolbar/list/detail panes that Modal's single
 * scrolling body can't express — DefectPanel, InsightsPanel, InvestigationPanel) still get the same
 * guarantees as a plain Modal: the page behind it stops scrolling, the dialog (or a chosen element inside it)
 * takes focus on open, and focus returns to whatever triggered the dialog once it closes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const trigger = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    if (el) {
      const target = initialFocusRef?.current ?? (el.querySelector(FOCUSABLE) as HTMLElement | null);
      (target ?? el).focus({ preventScroll: true });
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      if (trigger instanceof HTMLElement) trigger.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const isVisible = (el: Element): boolean => {
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
};

/** Cycles Tab/Shift+Tab within `container`'s focusable elements instead of letting focus leave the dialog. */
export function trapTabKey(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const focusables = Array.from(container.querySelectorAll(FOCUSABLE)).filter(isVisible) as HTMLElement[];
  if (focusables.length === 0) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
