# Kassa Brand Identity v0

Status: v0 (foundation). Owner: UI Designer. Linked issue: [KASA-11](/KASA/issues/KASA-11).
Scope: brand vision, logo system, app icon, voice & tone, illustration style, and brand application rules for the Kassa POS PWA, back office, and merchant-facing surfaces.

This document is the brand book. It sits **on top of** [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md), which owns the visual foundation (color tokens, type scale, spacing, components). Where the design system says *how things look*, this document says *who Kassa is and how it shows up*. Token names (`color.primary.600`, `font.sans`, `space.4`, etc.) are defined in DESIGN-SYSTEM.md and referenced here by name. Update via PR; revisions are logged at the bottom.

---

## 1. Brand vision

### 1.1 Who Kassa is

Kassa is the cash register that just works for Indonesian merchants — from the warung on the corner to a chain with twenty outlets. It is a Progressive Web App that takes a full sales day on a flaky 4G connection without losing a single transaction, and reconciles cleanly the moment it sees the network again.

Kassa is built **for** the merchant, not **for** an investor deck. It looks and reads like a tool, not a marketing surface. The cashier sees Kassa for ten hours a day; the brand has to stay out of their way.

### 1.2 What the brand stands for

- **Reliability over novelty.** Money is involved. The brand should signal "this won't lose your sale" before it signals anything else.
- **Calm over excitement.** The counter is busy. The brand should be the quiet thing in the room.
- **Clarity over polish.** A misread total is a bigger failure than an unstyled screen. Numbers are big, language is plain, contrast is high.
- **Quietly Indonesian.** Rooted in the warung and the kios — Bahasa-first copy, rupiah-first numerals, QRIS-first payment. We do not perform Indonesianness with batik patterns or garuda imagery. Per [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §1.5.
- **Open and approachable.** Open-source, affordable, documented in plain language. The brand should feel like a tool the merchant *owns*, not a service the merchant *rents*.

### 1.3 Emotional response we want

The first time a merchant sees Kassa: *"Oh — this looks like it works."* Not *"Wow, beautiful app."* Not *"This is enterprise-grade."* Just: *this looks like it works.*

The hundredth time the cashier sees Kassa, mid-shift: nothing. They should not notice it at all. Brand success at scale is invisibility.

### 1.4 Naming

**Kassa** (pronounced *KAH-sah*) — borrowed from the Dutch *kassa* ("cash register, till"), which entered Indonesian commercial vocabulary via colonial-era trade and is still recognizable alongside *kasir* (cashier). The name is one word, two syllables, easy to say and to type. Always written with a capital K and a lowercase remainder: **Kassa**, never KASSA, never kassa, never Kassa POS (the POS is implied).

---

## 2. Brand attributes

Every design or copy decision can be checked against these five attributes. A choice that adds nothing to any of them is decoration, and decoration loses.

| Attribute | What it means here | What it is *not* |
|-----------|--------------------|-------------------|
| **Dependable** | Looks engineered. Numerics align. State is honest ("Offline — saved locally"). | Boring, generic, "enterprise-blue". |
| **Calm** | Quiet color, generous spacing, low motion. | Sleepy, washed out, low contrast. |
| **Direct** | One primary action per screen. Plain words. Imperative verbs. | Curt, robotic, instruction-manual. |
| **Local** | Bahasa first, IDR, QRIS, warung-aware patterns. | Stereotyped, performative, "tropical". |
| **Open** | Documented, predictable, hireable-for. Plus Jakarta Sans (Indonesia-designed, OFL). Lucide icons (MIT). | Anti-design, hobbyist-looking, inconsistent. |

When in tension, **Dependable** wins. Calm and Direct usually agree. Local is a constant filter, not a feature. Open is how we ship and document, not a visual treatment.

---

## 3. Logo system

The Kassa logo has two elements — the **mark** and the **wordmark** — that may appear together (lockup) or independently. Both are constructed geometrically from the design-system grid so an engineer can produce them as SVG without rasters.

### 3.1 The mark

The Kassa mark is a stylized uppercase **K**, drawn from three line strokes on a 24-unit grid. It reads as a letterform at small sizes and as a chevron-pointing-forward at glance — a quiet nod to *the next sale, the next customer, the next shift*.

**Construction (24 × 24 unit grid, origin top-left, y-down):**

| Stroke | From | To | Width | Caps |
|--------|------|----|-------|------|
| 1 — vertical bar | (7, 4) | (7, 20) | 3 units | round |
| 2 — upper diagonal | (7, 12) | (19, 4) | 3 units | round |
| 3 — lower diagonal | (7, 12) | (19, 20) | 3 units | round |

All joins round. No fill — strokes only. The diagonals meet the vertical at the optical centre (y = 12), not the geometric centre, so the K reads balanced at small sizes.

**Color (mark only, transparent background):**

| Variant | Stroke color | Use on |
|---------|--------------|--------|
| Default (light) | `color.primary.700` | Light surfaces — `color.neutral.0` to `color.neutral.100` |
| Inverse (dark) | `color.neutral.0` | Dark surfaces — `color.neutral.900`, brand fills |
| Mono (positive) | `color.neutral.900` | Black-and-white print (receipts, invoices) |
| Mono (negative) | `color.neutral.0` | Black-and-white print on dark |

**Sizing:**

- Minimum size: **16 × 16 px** on screen, **6 mm** in print. Below this the strokes collapse on low-DPI printers.
- Default sizes follow the icon scale (see [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §5): `icon.md` 20 px (header), `icon.lg` 24 px (login), `icon.xl` 32 px (empty state).
- Always scale uniformly. Never stretch one axis.

Reference SVG: [docs/brand/kassa-mark.svg](./brand/kassa-mark.svg).

### 3.2 The wordmark

The wordmark is the literal word **Kassa** set in **Plus Jakarta Sans** (see [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §3.1).

| Property | Value |
|----------|-------|
| Typeface | Plus Jakarta Sans, weight 700 (Bold) |
| Case | Title case — `K` capital, `assa` lowercase |
| Letter spacing | -0.02em |
| Default color | `color.primary.700` on light, `color.neutral.0` on dark, `color.neutral.900` in B/W |
| Underline | None. Never underline the wordmark |

**Sizing:**

- Minimum size: **14 px** cap height on screen (the lowercase ascenders need that headroom), **5 mm** in print.
- Default sizes follow the type scale: `text.h3` (20 / 28) for product header, `text.h2` (24 / 32) for login, `text.display` (48 / 56) for splash.

Reference SVG: [docs/brand/kassa-wordmark.svg](./brand/kassa-wordmark.svg).

### 3.3 Lockups

Two canonical lockups. Engineers should compose these from the SVG mark and the live wordmark text — do not bake the wordmark into the mark SVG.

**Horizontal lockup (default):** mark on the left, wordmark on the right.

- Mark height = wordmark cap height × 1.6.
- Gap between mark and wordmark = 0.5 × wordmark cap height.
- Vertical alignment: mark optical centre (y = 12 of its grid) aligns with the wordmark cap-height centre.

**Stacked lockup (square contexts — app icon overlay, social avatar):** mark on top, wordmark below.

- Mark height = wordmark cap height × 2.0.
- Vertical gap between mark baseline and wordmark cap line = 0.6 × wordmark cap height.
- Horizontally centered on a shared vertical axis.

Reference SVGs: [docs/brand/kassa-lockup-horizontal.svg](./brand/kassa-lockup-horizontal.svg) and [docs/brand/kassa-lockup-stacked.svg](./brand/kassa-lockup-stacked.svg).

### 3.4 Clear space

Reserve clear space around any logo element equal to the **height of the wordmark cap** (or, for the standalone mark, half the mark height). No element — text, image, button, edge — may enter this zone. Backgrounds are allowed; foreground objects are not.

### 3.5 Color variants summary

| Surface | Mark | Wordmark |
|---------|------|----------|
| White / `color.neutral.0` | `color.primary.700` | `color.primary.700` |
| Light tint / `color.neutral.50–100` | `color.primary.700` | `color.primary.700` |
| Brand fill / `color.primary.600–700` | `color.neutral.0` | `color.neutral.0` |
| Dark / `color.neutral.900` | `color.neutral.0` | `color.neutral.0` |
| B/W print, light paper | `color.neutral.900` | `color.neutral.900` |
| B/W print, dark | `color.neutral.0` | `color.neutral.0` |

Never use a semantic color (success, warning, danger, info) for the logo. Never use a tender color (cash, qris) for the logo.

### 3.6 Don'ts

- Do not change the mark's stroke widths, end caps, or geometry.
- Do not fill the mark.
- Do not outline the wordmark.
- Do not rotate, skew, or apply perspective.
- Do not add drop shadows, glows, or gradients.
- Do not place the logo on a low-contrast background. If the background fails the WCAG AA contrast check against the chosen logo color (≥ 3:1 for graphics), pick a different variant or add a solid plate.
- Do not pair the logo with another mark in a "powered by" lockup without UI Designer review.
- Do not localize, translate, or transliterate the wordmark. *Kassa* is the word in every locale.

---

## 4. App icon and splash

### 4.1 App icon

Used for PWA install, Android home-screen, iOS home-screen, browser favicon, and any merchant-facing tile representation.

**Mark vs. app-icon glyph — they are intentionally different.**

The brand **mark** (§3.1) is the stroked geometric K used in lockups, product headers, receipts, and marketing surfaces. The **app icon** uses a *filled slab K* variant of the same letterform — same identity, different drawing — because the stroked mark thins out and softens at launcher sizes (192 px and below on low-DPI Androids), and was not designed against Android adaptive-mask geometry. The filled slab K holds shape down to favicon (32 px) and reads as a confident silhouette under circle, squircle, and rounded-square adaptive masks. This follows the established pattern of platform-shape-aware app icons (e.g. Slack's app tile vs. its wordmark mark).

The two are not interchangeable. App surfaces use the app-icon glyph; brand and marketing surfaces use the stroked mark.

**Construction — default tile (rounded square; iOS home-screen, favicon, default PWA install):**

- 512 × 512 canvas.
- Plate: rounded square, **17% corner radius** (`rx=88` at 512 px; scales with size — `rx=32` at 192 px).
- Fill: `color.primary.600`.
- Glyph: filled slab K in `color.neutral.0`, vertical bar `x ∈ [160, 212]` (width 52), full glyph bbox `x ∈ [160, 382]`, `y ∈ [116, 396]`. Diagonals meet the vertical bar in the waist region `y ∈ [234, 262]` (midpoint 248) — slightly above geometric centre (256), the same optical-balance rule used for the stroked mark.
- No padding ring beyond the plate edge; the plate **is** the silhouette.

**Construction — maskable variant (Android adaptive icons):**

- 512 × 512 canvas.
- Plate: full-bleed rectangle, no corner radius — the launcher applies the mask.
- Glyph: filled slab K in `color.neutral.0`, repositioned and resized so the entire glyph sits inside the **central 80% safe area** (`x ∈ [51.2, 460.8]`, `y ∈ [51.2, 460.8]`). Android may crop the outer 20% into a circle, squircle, or rounded square depending on the launcher.
- Verified safe under all three adaptive-mask shapes (see [KASA-127](/KASA/issues/KASA-127) evidence: `maskable-safezone.png`).

**Required sizes (PNG, rasterized in CI from the SVG sources):**

| Use | Size | Source SVG |
|-----|------|------------|
| Favicon (modern) | 32 × 32, 48 × 48 (ICO) | `apps/pos/public/icons/icon-192.svg` (downscaled) |
| Android home-screen | 192 × 192, 512 × 512 | `apps/pos/public/icons/icon-192.svg`, `icon-512.svg` |
| iOS home-screen | 180 × 180 | `apps/pos/public/icons/icon-512.svg` (downscaled) |
| Maskable icon (Android adaptive) | 512 × 512 with 80% safe area | `apps/pos/public/icons/icon-maskable-512.svg` |
| Splash — small | 1080 × 1080 | composed from the stacked lockup, see §4.2 |
| Splash — tablet portrait | 1536 × 2048 | composed from the stacked lockup, see §4.2 |
| Splash — tablet landscape | 2048 × 1536 | composed from the stacked lockup, see §4.2 |

**Canonical sources.** [`docs/brand/kassa-app-icon.svg`](./brand/kassa-app-icon.svg) is the brand-side master for the default tile. The shipped SVG set under `apps/pos/public/icons/` is design-faithful to that master at each size/variant axis: `icon-512.svg` is byte-equivalent (same artwork, shipped at 512), `icon-192.svg` is scaled to 192 with `rx` rounded to the integer grid (`rx=32`, still 17%), and `icon-maskable-512.svg` is full-bleed (no `rx`) with the glyph offset for the adaptive-mask safe zone (§4.1 maskable variant). When the master changes, the shipped SVGs **must** be regenerated and the PNGs re-rasterized in the same PR — the brand source and the shipped assets ship together or not at all.

### 4.2 Splash screen

Centered stacked lockup (§3.3) on a `color.primary.600` background. Mark is `color.neutral.0`. Wordmark is `color.neutral.0`. No tagline, no version number, no spinner — splash is shown for under 500 ms on a warm cache and should not invite reading.

If the splash takes longer than 1.5 s to dismiss (cold start, slow device), the app shell is broken. The fix is in the shell, not the splash.

### 4.3 Browser tab title

Default `<title>` is **Kassa** in product surfaces, **Kassa — Back office** in the back office. When a route is open: `Penjualan · Kassa`, `Katalog · Kassa`, etc. (Indonesian first, then bullet, then app name.)

---

## 5. Color in the brand context

Tokens are defined in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §2. The brand-relevant rules:

- **Brand color is `color.primary.600` ("Kasir Teal").** This is the only color that may appear at large fill on brand surfaces (splash, app icon, marketing hero blocks).
- **`color.primary.700` is the type color of the brand**, used for the wordmark on light surfaces and for primary headings on tinted backgrounds.
- **Tender and connection colors are not brand colors.** They identify a system state, not Kassa itself. Do not use `color.tender.qris` or `color.conn.offline` in brand artwork.
- **No new brand colors.** If a marketing surface needs a tint, use the existing scale. We do not introduce a "marketing pink" for one campaign.

---

## 6. Typography in the brand context

Type tokens are defined in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §3. The brand-relevant rules:

- **Plus Jakarta Sans is the only typeface used for brand expression.** No display face, no script face, no second sans.
- **JetBrains Mono is reserved for receipts, SKUs, and transaction IDs.** It is a system font, not a brand voice. Do not set headlines in mono.
- **The wordmark is set in Plus Jakarta Sans Bold (700).** Marketing surfaces may set headlines in ExtraBold (800) for compression in tight spaces; product UI uses 700 maximum.
- **Numerals are tabular, always.** Receipts, totals, charts, dashboards. The brand reads as engineered because the columns line up. See DESIGN-SYSTEM.md §3.2 for the `font-feature-settings` rule.
- **No italics.** Plus Jakarta Sans italics are not designed for body use.

### 6.1 The "Kassa underline"

A single allowed graphic flourish, used only on hero numerals in marketing and on receipt totals.

- A horizontal bar **3 px tall**, color `color.primary.500`, opacity 0.8.
- Sits flush below the baseline of the numeral it underlines, with a 2 px gap.
- Width matches the numeral's advance width — never extends beyond the digits.
- Used at most once per surface. Two underlines on one screen is one too many.

This is the only decorative line we ship. Drop shadows, swooshes, and gradients are out.

---

## 7. Iconography

Icon library, stroke, and grid are defined in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §5. The brand-relevant rules:

- **Lucide is the icon system.** Custom icons match Lucide's stroke (1.5 px on 24 grid), terminals (round caps), and joins (round). An icon that does not match Lucide visually is a bug.
- **No filled icons for emphasis.** Emphasis comes from color or size, not from switching to a filled glyph.
- **Custom Kassa icons** (cash-tender, QRIS chip, BOM recipe, outlet, receipt fold) live in `apps/<app>/src/icons/` once the apps are scaffolded; the SVG sources also live in [docs/brand/icons/](./brand/icons/) for reference. Each custom icon ships with a one-line caption explaining when to use it.
- **No third-party icon sets** alongside Lucide. If an icon is missing, draw it in Lucide style.

### 7.1 Custom icon list (v0)

Engineer ships these as part of the POS shell. Designer owns the SVG sources.

| Icon | Use |
|------|-----|
| `cash-tender` | Cash payment chip, cash totals row |
| `qris-chip` | QRIS payment chip (UI only — not the official QRIS scan mark) |
| `outlet` | Outlet selector, outlet column in tables |
| `bom-recipe` | Bill-of-materials indicator on a catalog tile |
| `receipt-fold` | Receipt preview button, receipt history row |
| `shift-open` | Shift status pill (open) |
| `shift-closed` | Shift status pill (closed) |

---

## 8. Illustration and imagery

### 8.1 Illustration

Kassa uses **almost no illustration** in the product. Empty states are the exception.

**Empty-state illustration spec:**

- Single-line drawings, **2 px stroke** at the export size.
- Color: `color.neutral.400` (line) on transparent background. A single tinted accent in `color.primary.200` is allowed for emphasis.
- Style matches Lucide — the same eye drew the icons and the illustrations.
- Maximum size: 96 × 96 px. Empty states are calm; they do not dominate the screen.
- Subjects: objects, not people. A receipt, a cart, an empty plate, an empty box. We do not draw cashiers or merchants — that work belongs to photography (§8.2).

### 8.2 Photography

Used in marketing only. Never inside the product UI.

- **Real Indonesian merchants in real environments.** Warung, kios, restoran, café, salon, toko bahan bangunan. No staged stock photography. No "white background, smiling person holding tablet."
- **Natural light.** Window light in the morning, fluorescent in the evening — both are honest.
- **Wide and medium shots.** A merchant at their counter, a tablet on the counter showing Kassa. Close-ups of hands and the screen are fine; close-ups of faces are not the priority.
- **No filters.** Light correction is fine; Instagram-style grading is not.
- **Diversity is built in, not added.** Indonesia is a 17,000-island country. Show that without commentary.

### 8.3 What we never depict

- Batik patterns, wayang, garuda, monas, becak — performative national symbols.
- Cash bills (rupiah notes) styled as photography. Stylized rupiah symbols (`Rp`) in type are fine.
- Coins falling, money trees, growth-arrow stock imagery.
- Tropical clichés (palm trees, beaches, sunset hues) unless the merchant being photographed is literally on a beach.
- AI-generated humans. People in our marketing are real merchants, photographed with consent and credited.

---

## 9. Voice and tone

### 9.1 Voice — what Kassa always sounds like

- **Plainspoken.** Words a merchant uses with their staff. "Tambah barang", not "Lakukan penambahan item ke keranjang transaksi."
- **Direct.** Imperative verbs. "Bayar Rp 47.500" beats "Anda dapat melanjutkan ke proses pembayaran sebesar Rp 47.500."
- **Honest about state.** Offline says "Offline — tersimpan lokal", not "Connection issue — we'll try again." Never euphemize a failure.
- **Bahasa Indonesia first.** English is a switchable secondary, not a fallback for missing Bahasa strings (see [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §3.4).
- **Second person, when person is needed.** *"Pindai QRIS pelanggan"*, not *"Cashier pindai QRIS pelanggan"*. The cashier is the reader.
- **No exclamation marks.** Exception: a single one on the post-sale confirmation toast (`Terjual!`). Nowhere else.

### 9.2 Tone — how the voice flexes

The voice is constant; the tone shifts with the moment. Three moments matter:

| Moment | Tone | Example |
|--------|------|---------|
| Routine action (add item, charge, close shift) | Neutral, confident, terse. Verb + object. | `Bayar Rp 47.500` · `Tutup shift` |
| Helpful pause (empty cart, no transactions yet, search returned nothing) | Helpful, not chatty. State the situation, offer the next step. | `Belum ada barang di keranjang. Ketuk sebuah barang untuk mulai.` |
| Error or sync failure | Plain, ownership-taking, actionable. Name the problem; offer the action. | `Sync gagal — ketuk untuk coba lagi` · `Stok kurang dari jumlah yang dimasukkan` |

We do not apologize ("Sorry, something went wrong"), we do not personify ("Oops! We hit a snag"), and we do not shrug ("Try again later"). We say what is wrong and what to do.

### 9.3 Vocabulary — the short list

| Concept | Use | Don't use | Why |
|---------|-----|-----------|-----|
| Cash | **Tunai** | Cash, Uang | Standard Indonesian POS term. |
| QRIS | **QRIS** | QR, QR Code | The official payment rail name. |
| Receipt | **Struk** | Resi, Bukti, Faktur | Faktur is for tax invoices; struk is the receipt. |
| Cart | **Keranjang** | Cart, Tas, Pesanan | Universal in Indonesian e-commerce/POS. |
| Charge / Tender | **Bayar** (verb) | Lakukan pembayaran, Settle | Imperative beats nominal. |
| Refund | **Refund** or **Kembalikan** | Pengembalian dana | "Refund" is widely understood; *Kembalikan* in fully-Indonesian contexts. |
| Void | **Batal** | Pembatalan, Cancel | Short, imperative. |
| Outlet | **Outlet** or **Cabang** | Lokasi, Toko (ambiguous) | "Outlet" is loaned; *cabang* in formal copy. |
| Stock | **Stok** | Persediaan, Inventory | Conversational shop-floor term. |
| Discount | **Diskon** | Potongan harga, Diskonto | The everyday word. |
| Out of stock | **Habis** | Tidak tersedia, Sold out | One word, fits a chip. |
| Offline | **Offline** | Luring, Tidak terhubung | "Offline" is universally understood and shorter. |
| Sync | **Sinkronisasi** (label), **Sync** (chip) | — | Long form for descriptions, short form for chips. |

### 9.4 English fallback

When English is the active locale:

- Same rules apply: imperative verbs, no exclamation, no apology, no personification.
- Use the **most common shop-floor English** word, not the most precise: *Cash* (not Tender), *Charge* (not Settle), *Receipt* (not Invoice), *Outlet* (not Location).
- Currency is still rendered via `Intl.NumberFormat('id-ID', { currency: 'IDR' })` — `Rp 47.500`, not `IDR 47,500.00`. The product is Indonesian; that does not change with the locale.

### 9.5 On-brand vs off-brand examples

| Off-brand | On-brand |
|-----------|----------|
| 🎉 Sale completed successfully! Thank you for your purchase! | Terjual! |
| Oops! We're having trouble syncing. Don't worry, we've got you. | Sync gagal — ketuk untuk coba lagi |
| Your cart is currently empty. Browse the catalog to begin building your order. | Belum ada barang di keranjang. Ketuk sebuah barang untuk mulai. |
| Are you sure you wish to proceed with deleting this transaction? | Batalkan transaksi ini? |
| Welcome back, Pak Budi! Ready to make some sales today? | Selamat pagi, Budi. Shift dibuka pukul 08:14. |
| **CHARGE NOW →** | Bayar Rp 47.500 |

The on-brand column is shorter, calmer, and more honest. It treats the cashier as a working adult.

---

## 10. Brand application

How the brand shows up on the surfaces that exist in v0.

### 10.1 Login screen

- Background: `color.neutral.0`. No hero image, no illustration.
- Centered stacked lockup (§3.3) in `color.primary.700` at the top of the form, mark height ≈ 56 px.
- Below the lockup, one line of supporting type — `text.body`, `color.neutral.500`: *"Masuk untuk memulai shift"*. No tagline, no marketing copy.
- Form below: email, password, primary button (`Masuk`), secondary `Lupa kata sandi`. Per the design system component spec.
- No "powered by", no version string, no third-party logos. The footer is empty.

### 10.2 POS header (in-app)

- Left: `kassa-mark.svg` at `icon.lg` (24 px), `color.primary.700`. No wordmark in the header — every pixel matters on a tablet POS surface.
- Centre: outlet name + active shift, `text.body`, `color.neutral.800`.
- Right: connection-state pill (DESIGN-SYSTEM.md §6.9), then user avatar.
- The mark is a tap target — tapping it opens the outlet/shift switcher. It is not a home link; the POS has no "home".

### 10.3 Receipt header

Receipts are the most-printed brand surface. Treat them with care.

- Centred at the top: the **wordmark only** (no mark) in `text.body`, weight 700, `color.neutral.900`. The mark does not survive 58 mm thermal printing reliably; the wordmark does.
- Below the wordmark: outlet name (`text.body-sm`, weight 600) and address (`text.caption`).
- Divider: a single dashed line, `color.neutral.300`.
- The body and footer follow DESIGN-SYSTEM.md §6.14.
- The total uses `text.price-lg` and is the only number on the receipt that may carry the **Kassa underline** (§6.1). On B/W thermal printers the underline becomes a solid black bar — that is intentional.

### 10.4 Empty states

- Use the empty-state illustration spec (§8.1).
- Heading is `text.h3`, body is `text.body`, both per the design system. Heading text is a one-line statement of the situation: *"Belum ada penjualan hari ini."* Body is one-line guidance: *"Penjualan akan muncul di sini setelah shift dimulai."*
- Action button is optional and used only when there is one obvious next step.

### 10.5 Onboarding emails (transactional)

Sent via Resend (per [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) referenced tech stack). HTML email template:

- Background `#FFFFFF`, single column, max width 560 px.
- Header: stacked lockup, centered, `color.primary.700` on white.
- Body: `Plus Jakarta Sans` with the standard fallback stack (most clients render the fallback; that is fine).
- One primary action button per email, styled like the design-system `primary` button.
- Footer: outlet support email, unsubscribe link if applicable, **no social-media icons**. We are a tool, not a content brand.

### 10.6 Marketing site (when it exists)

Not a v0 deliverable, but a v0 constraint: the marketing site, when it ships, **must not contradict** this document. Specifically:

- Same wordmark, same mark, same color palette, same typeface.
- No alternative "marketing brand" — the brand the merchant sees in the product is the brand the merchant sees in the ad.
- A separate marketing visual system (richer photography, more whitespace, hero typography in `text.display`) is allowed and expected. A separate marketing brand is not.

### 10.7 Social and avatar

- Profile avatar (Twitter/X, LinkedIn, GitHub org): the **stacked lockup** on `color.primary.600` background, full bleed.
- OpenGraph image (when sharing links): `1200 × 630`, `color.primary.600` background, stacked lockup centered, no other elements.

---

## 11. What we never do

A short list of things that are not Kassa, no matter who asks.

- A second typeface. (No "marketing display face.")
- A new brand color outside the design system scale.
- A mascot, character, or illustrated avatar.
- A drop shadow on the logo. A glow on the logo. A gradient on the logo.
- A skeuomorphic cash-register illustration.
- A "limited edition" Independence Day or Lebaran reskin of the logo. We celebrate by closing the office, not by recoloring the wordmark.
- An emoji in the product UI. (Marketing copy is allowed to use emoji sparingly; one per post is the ceiling.)
- A hero illustration of a smiling cashier giving a thumbs-up. Ever.
- A "powered by Kassa" badge on the merchant's receipts unless the merchant opts in. Kassa is the merchant's tool, not a billboard.

---

## 12. Asset registry

Where the brand assets live. All assets are committed to the repo as the source of truth — there is no Figma or Drive that is more authoritative than what is in `docs/brand/`.

| Asset | Path | Format |
|-------|------|--------|
| Mark (default) | [docs/brand/kassa-mark.svg](./brand/kassa-mark.svg) | SVG |
| Wordmark | [docs/brand/kassa-wordmark.svg](./brand/kassa-wordmark.svg) | SVG |
| Lockup — horizontal | [docs/brand/kassa-lockup-horizontal.svg](./brand/kassa-lockup-horizontal.svg) | SVG |
| Lockup — stacked | [docs/brand/kassa-lockup-stacked.svg](./brand/kassa-lockup-stacked.svg) | SVG |
| App icon (brand-side master, default tile) | [docs/brand/kassa-app-icon.svg](./brand/kassa-app-icon.svg) | SVG |
| App icon (shipped SVG sources) | `apps/pos/public/icons/icon-{192,512,maskable-512}.svg` | SVG |
| App icon (rasterized) | `apps/pos/public/icons/icon-{192,512,maskable-512}.png` (rasterized in CI from the shipped SVGs) | PNG |
| Custom product icons | [docs/brand/icons/](./brand/icons/) | SVG (Lucide-style) |

When the apps are scaffolded ([KASA-8](/KASA/issues/KASA-8) and follow-ups), engineers should consume these SVGs directly — do not duplicate. Rasterized PNGs for native install (Android, iOS) are generated from the SVG sources in CI; the script and configuration are owned by Engineer in a follow-up.

---

## 13. Tokens and implementation

Brand-specific implementation guidance. Tokens themselves are defined in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §10 and shipped by a downstream issue.

- The brand color palette **does not introduce new tokens.** Every brand reference resolves to a token from DESIGN-SYSTEM.md §2.
- The wordmark renders as **live text** in HTML wherever possible — it inherits the typeface and color tokens. The standalone `kassa-wordmark.svg` is for surfaces where text is not safe (Open Graph image, app icon overlay, print).
- The mark renders as **inline SVG** wherever possible (so it inherits `currentColor` and animates with CSS). The exported PNGs are only for native install icons and email clients that strip SVG.
- The Kassa underline (§6.1) renders as a **CSS pseudo-element** on the underlined numeral, not as an SVG asset. Construction:
  ```css
  .kassa-underline { position: relative; display: inline-block; }
  .kassa-underline::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -5px;
    height: 3px; background: var(--color-primary-500); opacity: 0.8;
  }
  ```

---

## 14. Out of scope (for v0)

Not in this brand book until v1 or later.

- **Sub-brands.** Kassa for Restoran, Kassa for Salon, etc. v0 is one brand for all merchant types.
- **A motion brand.** Logo animations, intro reels, video idents. The splash is the only brand-time-on-screen we ship.
- **A sonic brand.** Receipt-printed sounds, cha-ching, success chimes. v0 is silent. Haptic feedback (on supported devices) is a design-system concern, not a brand concern.
- **Merchandise.** T-shirts, stickers, mugs. We will print stickers eventually; we do not need a guideline for it yet.
- **Localized wordmarks.** *Kassa* is the wordmark in every market.
- **Dark mode for marketing.** Product dark mode is deferred per DESIGN-SYSTEM.md §12; marketing dark mode is deferred until product ships dark mode.

---

## Revision log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-22 | UI Designer | v0 — initial brand identity, linked to [KASA-11](/KASA/issues/KASA-11). |
| 2026-04-26 | UI Designer | §4.1 reworked — app icon is now a documented variant of the mark (filled slab K, not the stroked mark) for launcher legibility and adaptive-mask safety. Asset registry §12 updated. Brand-side master `docs/brand/kassa-app-icon.svg` regenerated to match the shipped `apps/pos/public/icons/icon-512.svg`. Linked to [KASA-129](/KASA/issues/KASA-129). |
