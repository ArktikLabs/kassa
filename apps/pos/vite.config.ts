import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const themeColor = "#0D9488";
const backgroundColor = "#FAFAF9";

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
        globPatterns: ["**/*.{js,css,html,svg,woff2,webmanifest}"],
      },
      manifest: {
        id: "/",
        name: "Kassa POS",
        short_name: "Kassa",
        description:
          "Kasir offline-first untuk warung dan toko kecil di Indonesia.",
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
});
