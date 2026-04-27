import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Build-time Sentry release tag (KASA-140). CI exports `GITHUB_SHA`; we
// derive `kassa-back-office@<sha12>` so the runtime `Sentry.init({ release })`
// matches the release name that `cd.yml` uploads source maps under.
// Local `vite build` / `vite dev` leave VITE_RELEASE unset so events from
// a developer machine are not falsely attributed to a CI release.
if (!process.env.VITE_RELEASE) {
  const sha = process.env.GITHUB_SHA?.slice(0, 12);
  if (sha) process.env.VITE_RELEASE = `kassa-back-office@${sha}`;
}

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5174,
    strictPort: false,
  },
  preview: {
    port: 4174,
  },
  // 'hidden' emits .map files but omits the `//# sourceMappingURL=` comment
  // from the bundled JS — Sentry uses the Debug ID injected by
  // `sentry-cli sourcemaps inject` for symbolication, so the public bundle
  // never advertises a source-map URL. The composite action deletes the
  // .map files from `dist/` after upload, before Cloudflare Pages publishes.
  build: {
    sourcemap: "hidden",
  },
});
