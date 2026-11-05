import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

/** Visual weight of a button. Use one `primary` per view. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Props for {@link Button}: every native button attribute, plus a few of our own. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Shows a spinner, sets `aria-busy` and disables the button while an action runs. */
  busy?: boolean;
}

/**
 * A native `<button>` (so keyboard and screen-reader behaviour come for free). Defaults to
 * `type="button"`, because the browser default (`submit`) causes accidental form posts.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('sp-btn', `sp-btn--${variant}`, size === 'sm' && 'sp-btn--sm', className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="sp-spinner sp-spinner--inline" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** Props for {@link IconButton}. `label` is mandatory: an icon alone has no accessible name. */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** Accessible name, also shown as a tooltip. */
  label: string;
  icon: ReactNode;
}

/** A square button showing only an icon, named by `label` (WCAG 4.1.2). */
export function IconButton({ label, icon, className, ...rest }: IconButtonProps) {
  return (
    <Button aria-label={label} title={label} className={cx('sp-icon-btn', className)} {...rest}>
      <span aria-hidden="true" className="sp-icon">
        {icon}
      </span>
    </Button>
  );
}
