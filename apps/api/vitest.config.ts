import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const schemasSrc = fileURLToPath(new URL("../../packages/schemas/src", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    passWithNoTests: false,
  },
  resolve: {
    alias: [
      { find: /^@kassa\/schemas$/, replacement: `${schemasSrc}/index.ts` },
      { find: /^@kassa\/schemas\/(.*)$/, replacement: `${schemasSrc}/$1.ts` },
    ],
  },
});
