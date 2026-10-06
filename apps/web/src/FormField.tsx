import type { ReactNode } from "react";

/**
 * A consistently styled form field with a persistent label, optional helper text,
 * required marker and inline error message. Replaces placeholders-as-labels.
 */
type FormFieldProps = {
  label: string;
  htmlFor?: string;
  required?: boolean;
  helper?: string | ReactNode;
  error?: string | null;
  children: ReactNode;
};

export function FormField({ label, htmlFor, required, helper, error, children }: FormFieldProps) {
  return (
    <div className="form-field">
      <label htmlFor={htmlFor} className="form-label">
        {label}
        {required && <span className="required" aria-hidden="true"> *</span>}
        {!required && <span className="optional"> (optional)</span>}
      </label>
      {helper && <p className="form-helper">{helper}</p>}
      {children}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
