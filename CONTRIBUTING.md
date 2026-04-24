# Contributing to Kassa

Thank you for your interest in contributing to Kassa. This guide describes how to get a change from your workstation into the main branch.

## Code of Conduct

All participation in Kassa project spaces is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1). By contributing, you agree to uphold it.

## License

Kassa is licensed under the **GNU Affero General Public License, version 3 or any later version** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text. By contributing, you agree that your contribution will be distributed under that license.

## Contributor License Agreement (CLA)

Before your **first** contribution can be merged, you must sign a Contributor License Agreement:

- **[Individual CLA (ICLA)](./legal/ICLA.md)** — if you are contributing on your own behalf.
- **[Corporate CLA (CCLA)](./legal/CCLA.md)** — if your contribution is made on behalf of an employer that has intellectual property rights over your work.

The CLA grants Kassa a perpetual, irrevocable, non-exclusive license to use, modify, and sublicense your contribution. This enables Kassa to offer the project under alternative license terms in the future (for example, a commercial license tier) while keeping the AGPL-3.0 license in place for the open-source distribution.

How to sign:

1. Read the applicable CLA document (`legal/ICLA.md` or `legal/CCLA.md`).
2. Fill in your name/entity and sign per the instructions at the bottom of that document.
3. Submit the signed document as described in the CLA (email or an equivalent signed-submission flow). Once we have automation in place, a CLA bot will confirm signature status directly on your pull request.

First-time contributors will see a CLA check on their pull request. A maintainer will not merge a PR from a contributor who has not signed the applicable CLA.

## Developer Certificate of Origin / `Signed-off-by`

In addition to the CLA, **every commit must carry a `Signed-off-by` trailer**. This certifies that you wrote or otherwise have the right to submit the patch under the project's license (see the [Developer Certificate of Origin 1.1](https://developercertificate.org/) for the standard text).

The easiest way to add the trailer is to use `-s` / `--signoff` on every commit:

```bash
git commit -s -m "feat: add thing"
```

The trailer looks like:

```
Signed-off-by: Your Name <you@example.com>
```

Pull requests containing commits without a `Signed-off-by` trailer will be asked to rebase with sign-off before merge.

## Commit Messages — Conventional Commits

Use the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format for every commit:

```
<type>: <short description>
```

Allowed `<type>` values: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`.

Rules:

- Lowercase after the colon.
- No period at the end of the subject.
- Subject under 72 characters.
- Reference the issue ID in the commit body when applicable (for example, `Refs: KASA-49`).

Examples:

- `feat: add offline queue flush retry`
- `fix: resolve null pointer in cart reducer`
- `docs: document CLA signing flow`

## Branching

Create one branch per issue using the lowercase issue prefix:

```
kasa-<N>/<short-description>
```

Examples: `kasa-49/add-license-and-contributing`, `kasa-12/fix-cart-rounding`.

Keep branches focused — one issue, one branch, one PR.

## Pull Request Process

1. Fork (external contributors) or create a branch on the main repository (maintainers).
2. Make your changes with Conventional Commit messages, each signed off with `git commit -s`.
3. Push the branch and open a pull request against `main`. Use the PR template in `.github/PULL_REQUEST_TEMPLATE.md` and confirm the CLA checkbox.
4. Ensure CI passes.
5. Set the originating issue to `in_review` and @-mention `@Code Reviewer` and `@Product Owner` with a link to the PR.
6. Address review feedback by pushing additional commits to the branch (no force pushes on shared branches).
7. A PR may be merged once **both** required reviewers have approved:
   - **Code Reviewer** — correctness, security, style, simplicity.
   - **Product Owner** — intent match, scope discipline, acceptance criteria.
8. The author merges using `gh pr merge <number> --merge` and sets the originating issue to `done`.

Direct-to-main is permitted only for typos, comment-only changes, and minor documentation fixes; all other changes require a PR.

## Style and Tooling

- Follow the conventions in [`docs/`](./docs/) (tech stack, architecture, design system) for code, naming, and UI contributions.
- Lint and format with Biome: `pnpm lint` checks, `pnpm lint:fix` auto-fixes lint+format. Config lives at [`biome.json`](./biome.json). CI runs `pnpm lint` and blocks merges on failure.
- Run tests locally before pushing (`pnpm -r test`). When a subsystem is scaffolded, per-package commands are documented in its `README`.

## Reporting Bugs and Proposing Changes

- **Bugs** — open an issue with steps to reproduce, expected vs. actual behaviour, environment (browser/OS/version), and a minimal reproduction if possible.
- **Feature proposals** — open an issue describing the problem, the proposed solution, and alternatives considered before writing code. Larger proposals may be asked to include an architecture note in `docs/`.

## Questions

If you are unsure about anything in this guide, open an issue with the `docs` label and we will clarify.
