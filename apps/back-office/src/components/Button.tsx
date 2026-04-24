import type { ButtonHTMLAttributes } from "react";

/*
 * Button — DESIGN-SYSTEM §6.1 variants.
 *
 * Three variants cover the back-office: primary (page action), ghost
 * (secondary/cancel), and destructive (deactivate/revoke). Height
 * follows §6.4 — 40px on back-office tables.
 */

type Variant = "primary" | "ghost" | "destructive";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary-600 text-white hover:bg-primary-700 focus-visible:ring-primary-500",
  ghost:
    "bg-white text-neutral-800 border border-neutral-300 hover:bg-neutral-100 focus-visible:ring-neutral-400",
  destructive: "bg-danger-solid text-white hover:bg-danger-fg focus-visible:ring-danger-solid",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function Button({ variant = "primary", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
