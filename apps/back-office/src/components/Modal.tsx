import { useEffect, useRef, type ReactNode } from "react";
import { FormattedMessage } from "react-intl";

/*
 * Modal — DESIGN-SYSTEM §6.10.
 *
 * - Centered, max-width 560px, radius.lg, shadow.lg, scrim #1C191780.
 * - Header: text.h3 + close icon. Body: space.6 padding. Footer:
 *   right-aligned actions, caller-owned.
 * - ESC closes. Focus is trapped; the first focusable element receives
 *   focus on open. Reduced-motion is honored by the global CSS rule.
 */

export type ModalProps = {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledById?: string;
};

export function Modal({ open, title, onClose, children, footer, labelledById }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = labelledById ?? "modal-title";

  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement as HTMLElement | null;
    const container = dialogRef.current;
    if (container) {
      const firstFocusable = container.querySelector<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? container).focus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const focusables = container.querySelectorAll<HTMLElement>(
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousActive?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" aria-hidden={false}>
      <div className="absolute inset-0 bg-neutral-900/50" aria-hidden onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative z-10 w-full max-w-[560px] rounded-lg bg-white shadow-lg focus:outline-none"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-neutral-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            aria-label="close"
          >
            <FormattedMessage id="modal.close" />
          </button>
        </header>
        <div className="px-6 py-6">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50 px-6 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
