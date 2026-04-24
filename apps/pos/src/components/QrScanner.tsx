/*
 * Lightweight QR scanner using the native BarcodeDetector API and
 * getUserMedia. Feature-detected: if the browser lacks BarcodeDetector
 * (iPadOS Safari as of v17 is the notable holdout per TECH-STACK.md §7.1),
 * `isBarcodeDetectorSupported()` returns false and the caller should fall
 * back to manual entry.
 */
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
  };
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof globalThis === "undefined") return null;
  const candidate = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  return typeof candidate === "function" ? candidate : null;
}

export function isBarcodeDetectorSupported(): boolean {
  return getBarcodeDetectorCtor() !== null;
}

interface QrScannerProps {
  onDetected: (value: string) => void;
  onClose: () => void;
}

export function QrScanner({ onDetected, onClose }: QrScannerProps) {
  const intl = useIntl();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    stoppedRef.current = false;
    const Ctor = getBarcodeDetectorCtor();
    if (!Ctor) {
      setError(intl.formatMessage({ id: "enrol.qr.unsupported" }));
      return;
    }
    const detector = new Ctor({ formats: ["qr_code"] });

    const stop = (): void => {
      stoppedRef.current = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stoppedRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const tick = async (): Promise<void> => {
          if (stoppedRef.current) return;
          try {
            const results = await detector.detect(video);
            const first = results[0];
            if (first && typeof first.rawValue === "string" && first.rawValue.length > 0) {
              stop();
              onDetected(first.rawValue);
              return;
            }
          } catch {
            // transient detect() failures (codec reshuffle, tab background)
            // should not abort the scan loop; keep polling.
          }
          rafRef.current = requestAnimationFrame(() => {
            void tick();
          });
        };
        void tick();
      } catch (err) {
        const message =
          err instanceof Error && err.name === "NotAllowedError"
            ? intl.formatMessage({ id: "enrol.qr.permission" })
            : intl.formatMessage({ id: "enrol.qr.camera_failed" });
        setError(message);
      }
    })();

    return stop;
  }, [intl, onDetected]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-black/90 p-4 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage({ id: "enrol.qr.dialog_label" })}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{intl.formatMessage({ id: "enrol.qr.heading" })}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20"
        >
          {intl.formatMessage({ id: "enrol.qr.close" })}
        </button>
      </header>
      <div className="mt-4 flex flex-1 items-center justify-center">
        {error ? (
          <p className="max-w-md text-center text-sm text-red-200">{error}</p>
        ) : (
          <video
            ref={videoRef}
            className="max-h-full max-w-full rounded-md"
            playsInline
            muted
          />
        )}
      </div>
      <p className="mt-2 text-center text-xs text-white/70">
        {intl.formatMessage({ id: "enrol.qr.hint" })}
      </p>
    </div>
  );
}
