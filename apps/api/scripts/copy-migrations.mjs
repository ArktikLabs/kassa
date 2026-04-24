#!/usr/bin/env node
/*
 * Copy the Drizzle migration artefacts into `dist/` so the CI `api-dist`
 * artifact (see `.github/workflows/ci.yml`) carries them to the Fly
 * release_command. `tsc` only emits `.js`; it doesn't know about `.sql`
 * or Drizzle's `meta/` journal.
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src", "db", "migrations");
const dst = path.join(here, "..", "dist", "db", "migrations");

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
// biome-ignore lint/suspicious/noConsole: build script output is intentional.
console.log(`copied migrations: ${src} → ${dst}`);
