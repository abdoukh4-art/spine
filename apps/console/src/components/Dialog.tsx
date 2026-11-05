import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';

/** Props for {@link Dialog}. */
export interface DialogProps {
  open: boolean;
  /** Called when the dialog closes for any reason (Escape, close button, `open=false`). */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons row; usually Cancel + a primary action. */
  footer?: ReactNode;
}

/**
 * A modal built on the native `<dialog>` element. `showModal()` gives us, for free and
 * correctly: the top layer, an inert background (focus cannot leave the dialog, which is
 * the focus trap), Escape to close, and `::backdrop`. We add only two things: the title as
 * the accessible name, and **returning focus** to whatever opened the dialog.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleClose = () => {
    const target = opener.current;
    opener.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    // The opener may be gone (e.g. an optimistic update removed its row): fall back to
    // <main> so focus doesn't drop to <body>, which screen readers announce as "blank".
    else document.getElementById('main')?.focus();
    onClose();
  };

  return (
    <dialog ref={ref} className="sp-dialog" aria-labelledby={titleId} onClose={handleClose}>
      <div className="sp-dialog__header">
        <h2 id={titleId} className="sp-dialog__title">
          {title}
        </h2>
        <IconButton
          label="Close dialog"
          variant="ghost"
          icon="✕"
          onClick={() => ref.current?.close()}
        />
      </div>
      <div className="sp-dialog__body">{open ? children : null}</div>
      {footer && open ? <div className="sp-dialog__footer">{footer}</div> : null}
    </dialog>
  );
}
