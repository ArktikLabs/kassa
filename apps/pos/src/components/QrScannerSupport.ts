// Tiny feature-detect for the native BarcodeDetector API. Split from
// `QrScanner.tsx` so the heavy scanner component (camera plumbing,
// detection loop) stays out of the initial enrol-screen chunk and only
// loads once the clerk taps "Scan QR" (KASA-157).
interface BarcodeDetectorCtor {
  new (options?: {
    formats?: string[];
  }): {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
  };
}

export function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof globalThis === "undefined") return null;
  const candidate = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  return typeof candidate === "function" ? candidate : null;
}

export function isBarcodeDetectorSupported(): boolean {
  return getBarcodeDetectorCtor() !== null;
}
