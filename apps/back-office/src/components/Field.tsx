import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/*
 * Minimal form field primitives so every CRUD form renders a
 * consistent label + control + helper/error block. Swapping these for
 * react-hook-form bindings is a downstream concern; the scaffold
 * keeps to uncontrolled/controlled-by-parent inputs so the test
 * harness can drive them with @testing-library/user-event directly.
 */

export type FieldProps = {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
};

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-neutral-800"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

const INPUT_BASE =
  "block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={[INPUT_BASE, props.className ?? ""].join(" ")} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={[INPUT_BASE, props.className ?? ""].join(" ")} />
  );
}

export function Checkbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-neutral-800">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
        {...rest}
      />
      {label}
    </label>
  );
}
