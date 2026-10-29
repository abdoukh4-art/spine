import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';

/** Props shared by every labelled control. */
export interface FieldOwnProps {
  /** Visible label (WCAG 3.3.2). */
  label: string;
  /** Helper text shown under the label and linked with `aria-describedby`. */
  hint?: string | undefined;
  /** Error message; marks the control `aria-invalid` and links the message. */
  error?: string | undefined;
  /** Hide the label visually (it stays the accessible name). Use sparingly. */
  labelHidden?: boolean;
}

/** The ids and ARIA attributes a control needs to be wired to its label, hint and error. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/**
 * Label + control + hint + error, wired together. The control is a render prop so the
 * same wiring serves inputs, selects and textareas.
 */
export function Field({
  label,
  hint,
  error,
  labelHidden = false,
  className,
  children,
}: FieldOwnProps & { className?: string; children: (props: FieldControlProps) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const controlProps: FieldControlProps = { id };
  if (describedBy) controlProps['aria-describedby'] = describedBy;
  if (error) controlProps['aria-invalid'] = true;
  return (
    <div className={cx('sp-field', error && 'sp-field--error', className)}>
      <label htmlFor={id} className={labelHidden ? 'visually-hidden' : 'sp-field__label'}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="sp-field__hint">
          {hint}
        </p>
      ) : null}
      {children(controlProps)}
      {error ? (
        <p id={errorId} className="sp-field__error">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled `<input>`. */
export function TextInput({
  label,
  hint,
  error,
  labelHidden,
  className,
  ...input
}: FieldOwnProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      labelHidden={labelHidden ?? false}
      className={className ?? ''}
    >
      {(props) => <input className="sp-input" {...input} {...props} />}
    </Field>
  );
}

/** One `<option>` of a {@link Select}. */
export interface SelectOption {
  value: string;
  label: string;
}

/** A labelled native `<select>` (native beats a custom listbox for accessibility). */
export function Select({
  label,
  hint,
  error,
  labelHidden,
  className,
  options,
  ...select
}: FieldOwnProps & SelectHTMLAttributes<HTMLSelectElement> & { options: readonly SelectOption[] }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      labelHidden={labelHidden ?? false}
      className={className ?? ''}
    >
      {(props) => (
        <select className="sp-input sp-select" {...select} {...props}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** A labelled `<textarea>`. */
export function Textarea({
  label,
  hint,
  error,
  labelHidden,
  className,
  ...textarea
}: FieldOwnProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      labelHidden={labelHidden ?? false}
      className={className ?? ''}
    >
      {(props) => <textarea className="sp-input sp-textarea" {...textarea} {...props} />}
    </Field>
  );
}

/** Props for {@link CheckboxGroup}. */
export interface CheckboxGroupProps<T extends string> {
  legend: string;
  options: readonly { value: T; label: ReactNode }[];
  value: readonly T[];
  onChange: (value: T[]) => void;
}

/** A `<fieldset>` of checkboxes for multi-select filters (no custom listbox needed). */
export function CheckboxGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
}: CheckboxGroupProps<T>) {
  const toggle = (option: T, checked: boolean) => {
    const next = checked ? [...value, option] : value.filter((v) => v !== option);
    onChange(options.map((o) => o.value).filter((v) => next.includes(v)));
  };
  return (
    <fieldset className="sp-checkbox-group">
      <legend className="sp-field__label">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="sp-checkbox">
          <input
            type="checkbox"
            checked={value.includes(option.value)}
            onChange={(event) => toggle(option.value, event.target.checked)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
