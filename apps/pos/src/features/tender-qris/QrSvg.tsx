import { useMemo } from "react";
import QrCodeSvg from "qrcode-svg";

/*
 * Renders an EMV-compatible QRIS payload as an inline SVG. `qrcode-svg`
 * returns an `<svg>` string; injecting it via `dangerouslySetInnerHTML`
 * keeps the bundle small (no canvas) and lets Tailwind size the wrapper
 * without re-rendering on every poll tick.
 *
 * The acceptance criteria names `qrcode-svg` explicitly. Size defaults to
 * 288 px square — DESIGN-SYSTEM.md does not yet pin a QRIS dimension
 * (see §5.8 gap); 288 fits the tender panel on a 10" tablet without
 * leaving a large dead zone below the fold.
 */

export interface QrSvgProps {
  /** The EMV string Midtrans returned (`qr_string`). */
  value: string;
  /** Square side length in px. Defaults to 288. */
  size?: number;
  className?: string;
  testId?: string;
}

export function QrSvg({ value, size = 288, className, testId }: QrSvgProps) {
  const markup = useMemo(() => {
    const svg = new QrCodeSvg({
      content: value,
      width: size,
      height: size,
      padding: 4,
      ecl: "M",
      background: "#ffffff",
      color: "#000000",
      join: true,
    }).svg();
    return svg;
  }, [value, size]);

  return (
    <div
      className={className ?? "inline-flex items-center justify-center rounded-lg bg-white p-2"}
      style={{ width: size + 16, height: size + 16 }}
      data-testid={testId ?? "qris-qr"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: qrcode-svg returns a static, sanitized <svg> we fully control.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
