import { useCallback, useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessibility helper for modal dialogs: when `active`, move focus into the
 * dialog, keep Tab/Shift+Tab cycling inside it, close on Escape, and restore
 * focus to the previously-focused element when it closes. Returns a ref to put
 * on the dialog container (which should also carry `tabIndex={-1}`).
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void): React.RefObject<T> {
  const ref = useRef<T>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  const focusables = useCallback((node: HTMLElement): HTMLElement[] => {
    return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the first interactive control, falling back to the container.
    (focusables(node)[0] ?? node).focus?.();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        escapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(node);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [active, focusables]);

  return ref;
}
