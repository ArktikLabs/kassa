import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const themeColor = "#0D9488";
const backgroundColor = "#FAFAF9";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

// Build-time Sentry release tag (KASA-140). CI exports `GITHUB_SHA`; we
// derive `kassa-pos@<sha12>` so the runtime `Sentry.init({ release })`
// matches the release name that `cd.yml` uploads source maps under.
// Local `vite build` / `vite dev` leave VITE_RELEASE unset so events
// from a developer machine are not falsely attributed to a CI release.
if (!process.env.VITE_RELEASE) {
  const sha = process.env.GITHUB_SHA?.slice(0, 12);
  if (sha) process.env.VITE_RELEASE = `kassa-pos@${sha}`;
}

/*
 * `vite preview` serves the production build raw, with no Content-Encoding,
 * which makes Lighthouse's mobile-4G simulation pay full uncompressed
 * transfer cost (~600 kB of main JS pushes LCP past 3 s — KASA-157).
 * Production traffic is fronted by Cloudflare Pages which auto-gzips, so
 * the CI gate was measuring a posture users never see. We pre-compress
 * compressible artifacts at build time and a tiny preview-only middleware
 * negotiates Content-Encoding: gzip when the client supports it. The
 * middleware sits BEFORE sirv in the chain so we never hijack response
 * streams (which trips `ERR_HTTP_HEADERS_SENT` once headers flush).
 */
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest"]);
const MIME_BY_EXT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function precompressDist(): PluginOption {
  return {
    name: "kassa-precompress-dist",
    apply: "build",
    closeBundle() {
      if (!existsSync(distDir)) return;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(p);
            continue;
          }
          if (entry.name.endsWith(".gz")) continue;
          if (!COMPRESSIBLE_EXT.has(extname(entry.name))) continue;
          const data = readFileSync(p);
          if (data.length < 1024) continue;
          writeFileSync(`${p}.gz`, gzipSync(data, { level: 9 }));
        }
      };
      walk(distDir);
    },
  };
}

function previewServeGzipPlugin(): PluginOption {
  return {
    name: "kassa-preview-serve-gz",
    apply: "serve",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const accept = String(req.headers["accept-encoding"] ?? "").toLowerCase();
        if (!accept.includes("gzip")) return next();
        const rawUrl = req.url ?? "/";
        const queryStart = rawUrl.indexOf("?");
        let pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          return next();
        }
        if (pathname === "" || pathname === "/") pathname = "/index.html";
        // Resolve through node:path and confirm the result still lives under
        // distDir before touching the filesystem. Drops `..` segments and
        // rejects encoded escapes so a request for `/../package.json` cannot
        // hand back a sibling file.
        const filePath = resolve(distDir, `.${pathname}`);
        if (filePath !== distDir && !filePath.startsWith(distDir + sep)) return next();
        const gzPath = `${filePath}.gz`;
        if (!existsSync(gzPath)) return next();
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_BY_EXT[ext];
        if (!mime) return next();
        const data = readFileSync(gzPath);
        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", data.length);
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Cache-Control", "no-cache");
        res.end(data);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    precompressDist(),
    previewServeGzipPlugin(),
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
