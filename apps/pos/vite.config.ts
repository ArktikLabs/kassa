import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const themeColor = "#0D9488";
const backgroundColor = "#FAFAF9";

// Build-time Sentry release tag (KASA-140). CI exports `GITHUB_SHA`; we
// derive `kassa-pos@<sha12>` so the runtime `Sentry.init({ release })`
// matches the release name that `cd.yml` uploads source maps under.
// Local `vite build` / `vite dev` leave VITE_RELEASE unset so events
// from a developer machine are not falsely attributed to a CI release.
if (!process.env.VITE_RELEASE) {
  const sha = process.env.GITHUB_SHA?.slice(0, 12);
  if (sha) process.env.VITE_RELEASE = `kassa-pos@${sha}`;
}

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      registerType: "prompt",
      devOptions: {
        enabled: false,
        type: "module",
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
      },
      manifest: {
        id: "/",
        name: "Kassa POS",
        short_name: "Kassa",
        description: "Kasir offline-first untuk warung dan toko kecil di Indonesia.",
        lang: "id-ID",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        theme_color: themeColor,
        background_color: backgroundColor,
        categories: ["business", "finance", "productivity"],
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/icons/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/icon-maskable-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
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
