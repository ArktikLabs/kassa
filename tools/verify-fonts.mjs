#!/usr/bin/env node
// Replays the SHA256 provenance check from KASA-76 / PR #2 over the four
// vendored font assets under apps/pos/public/fonts/. Run `pnpm verify:fonts`
// (or `node tools/verify-fonts.mjs`) from the repo root; exit 0 means every
// vendored byte still matches the locked upstream-derived hash, non-zero
// means at least one file has drifted.
//
// Updating the locked list:
// A legitimate re-conversion (new upstream pin in google/fonts, glyph subset
// change, woff2 tooling rev) MUST land in the same commit that rotates the
// hashes here. Bump the upstream commit + version in `notes`, replace the
// hex digests in LOCKED_FILES with `sha256sum apps/pos/public/fonts/<file>`
// output, and reference both the upstream commit and the converter version
// in the commit message — the same shape KASA-76 used.
//
// no runtime deps; uses node:crypto + node:fs/promises only.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = join("apps", "pos", "public", "fonts");

/** @type {ReadonlyArray<{file: string, sha256: string, notes: string}>} */
const LOCKED_FILES = [
  {
    file: "plus-jakarta-sans-var.woff2",
    sha256: "316f2544b4f2ae200eb2706bb8197056297a7e333ba0dc037ccae2efc6559ae3",
    notes: "Plus Jakarta Sans v2.071 — google/fonts@8cd7d0de182c88592d6852c245fe48f66eef55ee",
  },
  {
    file: "jetbrains-mono-var.woff2",
    sha256: "11038e282dd7cb983dfc4e565017f37a91041c073c8929771fb6e64d27814396",
    notes: "JetBrains Mono v2.211 — google/fonts@2e05c1cf00a6e4f40a4b931600a90881c26e15cd",
  },
  {
    file: "PLUS-JAKARTA-SANS-OFL.txt",
    sha256: "995c7199cab65954f545996326755daee7b63cc6b42b06c13da1f9502ab08a99",
    notes: "OFL-1.1 license shipped alongside Plus Jakarta Sans",
  },
  {
    file: "JETBRAINS-MONO-OFL.txt",
    sha256: "b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d",
    notes: "OFL-1.1 license shipped alongside JetBrains Mono",
  },
];

async function sha256(absPath) {
  const buf = await readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const results = await Promise.all(
    LOCKED_FILES.map(async (entry) => {
      const relPath = join(FONT_DIR, entry.file);
      const absPath = join(REPO_ROOT, relPath);
      try {
        const actual = await sha256(absPath);
        return {
          ...entry,
          relPath,
          actual,
          ok: actual === entry.sha256,
          error: null,
        };
      } catch (err) {
        return {
          ...entry,
          relPath,
          actual: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.info(`ok    ${r.relPath}  sha256=${r.actual}`);
    } else if (r.error) {
      failed += 1;
      console.error(`FAIL  ${r.relPath}`);
      console.error(`      read error: ${r.error}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${r.relPath}`);
      console.error(`      expected ${r.sha256}`);
      console.error(`      actual   ${r.actual}`);
      console.error(`      source   ${r.notes}`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n${failed} of ${results.length} vendored font asset(s) failed SHA256 verification.`,
    );
    console.error(
      "If this is a legitimate re-conversion, rotate the locked hashes in tools/verify-fonts.mjs in the same commit.",
    );
    process.exit(1);
  }

  console.info(`\nAll ${results.length} vendored font asset(s) match the locked SHA256 list.`);
}

main().catch((err) => {
  console.error("verify-fonts: unexpected error");
  console.error(err);
  process.exit(2);
});
