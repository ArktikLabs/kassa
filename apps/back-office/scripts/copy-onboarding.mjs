#!/usr/bin/env node
/*
 * Copy `docs/ONBOARDING.md` into `apps/back-office/public/onboarding.md`
 * so Vite serves it at `/onboarding.md` in dev and bundles it into the
 * production build.
 *
 * The back-office login screen links to this file (KASA-69) so a brand-new
 * merchant who lands on the login page on day one can read the runbook
 * before they have credentials. We copy at build/dev time rather than
 * symlinking so the workflow is portable across Windows/Linux CI runners
 * and the file lives inside the back-office bundle without any custom
 * Vite plugin.
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "..", "docs", "ONBOARDING.md");
const dst = path.resolve(here, "..", "public", "onboarding.md");

await mkdir(path.dirname(dst), { recursive: true });
await cp(src, dst);
// biome-ignore lint/suspicious/noConsole: build script output is intentional.
console.log(`copied onboarding runbook: ${src} → ${dst}`);
