import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

interface BottomSheetProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  labelledById?: string;
}

/*
 * Minimal bottom-sheet per DESIGN-SYSTEM §6.10: pinned, drag handle,
 * focus-trap-lite (first focusable gets focus on open, Esc closes).
 * Full swipe-to-close arrives with the sheet-driven variant picker;
 * for the cart edit flow the sheet is small and the close button is
 * always visible.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  labelledById,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable =
      panel?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? null;
    focusable?.focus();
    return () => {
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center"
      aria-hidden={false}
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-900/50"
        onClick={onClose}
        aria-label="Tutup"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
        onKeyDown={handleKey}
        className="relative z-10 w-full max-w-[560px] rounded-t-lg bg-white pb-6 shadow-lg"
      >
        <div className="flex justify-center pt-2">
          <span
            aria-hidden
            className="h-1 w-10 rounded-full bg-neutral-300"
          />
        </div>
        <div className="px-5 pt-2 pb-1">
          <h2
            id={labelledById}
            className="text-base font-bold text-neutral-900"
          >
            {title}
          </h2>
        </div>
        <div className="px-5 pt-3">{children}</div>
      </div>
    </div>
  );
}
