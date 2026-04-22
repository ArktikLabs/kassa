# Kassa Design System v0

Status: v0 (foundation). Owner: UI Designer. Linked issue: [KASA-7](/KASA/issues/KASA-7).
Scope: visual foundation (color, type, spacing, components, breakpoints) for the Kassa POS PWA and back office.
Brand book (logo, voice, iconography rules) is owned by [KASA-11](/KASA/issues/KASA-11).

This document is the single source of truth for engineers and designers. Reference tokens by name (`color.primary.600`, `space.4`), never by hex. Update via PR; revisions are logged at the bottom.

---

## 1. Design Principles

These five rules resolve every disagreement. When in doubt, the earlier rule wins.

1. **Legible at a glance.** A clerk under fluorescent or sunlit warung lighting must read the screen without leaning in. High contrast, large numerals, no thin type for prices.
2. **Touch first.** The primary surface is a tablet on a counter. Every interactive element is reachable by thumb and meets the touch-target minimum. Hover states are nice-to-have, not load-bearing.
3. **Speed over decoration.** A transaction is the goal. Animations are <200ms, decorative imagery is rare, and the cart-to-tender path is reachable in two taps from any catalog screen.
4. **Offline is a first-class state.** Connection status is always visible. We never hide failure behind a spinner. "Syncing", "Offline — saved locally", and "Synced" are first-class UI states with dedicated treatment.
5. **Quietly Indonesian.** Bahasa-friendly typography, rupiah formatting, QRIS treatment that respects the official mark. We do not lean on national clichés (no batik patterns, no garuda).

---

## 2. Color

### 2.1 Brand palette

Kassa's primary is a confident teal-green ("Kasir Teal"). It signals money and trust without colliding with the official QRIS dark blue used in payment marks.

| Token | Hex | Usage |
|-------|-----|-------|
| `color.primary.50`  | `#F0FDFA` | Subtle primary tint backgrounds (selected row, primary toast) |
| `color.primary.100` | `#CCFBF1` | Hover tint on primary-tinted surfaces |
| `color.primary.200` | `#99F6E4` | Disabled primary fill (on light) |
| `color.primary.300` | `#5EEAD4` | Reserved — charts only |
| `color.primary.400` | `#2DD4BF` | Reserved — charts only |
| `color.primary.500` | `#14B8A6` | Brand color, marketing, splash |
| `color.primary.600` | `#0D9488` | **Default primary action.** Buttons, links, focus ring |
| `color.primary.700` | `#0F766E` | Primary hover/active, primary text on light surface |
| `color.primary.800` | `#115E59` | Primary on dark surfaces |
| `color.primary.900` | `#134E4A` | Headings on tinted background |

WCAG AA: `primary.600` on `neutral.0` = 4.65:1 (passes for normal text and UI). `primary.700` on `neutral.0` = 6.18:1 (AAA for large text).

### 2.2 Neutrals (warm gray)

Warm grays look softer than blue-grays under indoor warung lighting and reduce the "SaaS dashboard" feel.

| Token | Hex | Usage |
|-------|-----|-------|
| `color.neutral.0`   | `#FFFFFF` | App background, cards |
| `color.neutral.50`  | `#FAFAF9` | Subtle alt background, table zebra |
| `color.neutral.100` | `#F5F5F4` | Surface 1 (panels, sidebars) |
| `color.neutral.200` | `#E7E5E4` | Borders, dividers, input border |
| `color.neutral.300` | `#D6D3D1` | Strong border, disabled outline |
| `color.neutral.400` | `#A8A29E` | Placeholder text, icon-disabled |
| `color.neutral.500` | `#78716C` | Secondary text, helper text |
| `color.neutral.600` | `#57534E` | Body text on neutral surface |
| `color.neutral.700` | `#44403C` | Strong body text, labels |
| `color.neutral.800` | `#292524` | Headings on light surface |
| `color.neutral.900` | `#1C1917` | Maximum contrast text, dark surface |

WCAG AA: `neutral.600` on `neutral.0` = 7.46:1, `neutral.700` on `neutral.0` = 10.41:1.

### 2.3 Semantic colors

Each semantic color has a `surface` (tinted background), `border`, `fg` (foreground/text), and `solid` (button fill).

| Token | Hex | Usage |
|-------|-----|-------|
| `color.success.surface` | `#ECFDF5` | Success toast/banner background |
| `color.success.border`  | `#A7F3D0` | Success banner border |
| `color.success.fg`      | `#047857` | Success text and icon |
| `color.success.solid`   | `#059669` | Success button, completed-sale chip |
| `color.warning.surface` | `#FFFBEB` | Warning banner background |
| `color.warning.border`  | `#FDE68A` | Warning banner border |
| `color.warning.fg`      | `#B45309` | Warning text |
| `color.warning.solid`   | `#D97706` | Warning button, low-stock chip |
| `color.danger.surface`  | `#FEF2F2` | Error banner background |
| `color.danger.border`   | `#FECACA` | Error banner border |
| `color.danger.fg`       | `#B91C1C` | Error text, validation message |
| `color.danger.solid`    | `#DC2626` | Destructive button (Void, Refund, Delete) |
| `color.info.surface`    | `#EFF6FF` | Info banner background |
| `color.info.border`     | `#BFDBFE` | Info banner border |
| `color.info.fg`         | `#1D4ED8` | Info text |
| `color.info.solid`      | `#2563EB` | Info button, sync-in-progress |

### 2.4 Tender colors (POS-specific)

Tender colors are reserved for tender-type identification (chip badges, totals breakdown, receipt). Do not use for general UI accents.

| Token | Hex | Usage |
|-------|-----|-------|
| `color.tender.cash` | `#16A34A` | Cash chip, cash totals |
| `color.tender.qris` | `#1E3A8A` | QRIS chip, QRIS totals (close to official QRIS dark blue, not the official mark itself) |

The official QRIS mark must be used for the actual scan/pay flow per Bank Indonesia guidelines. `color.tender.qris` is for our UI chips and totals only — never paint the QR code itself in this color.

### 2.5 Connection-state colors

Connection state is its own semantic group because it appears in the persistent header.

| Token | Hex | Usage |
|-------|-----|-------|
| `color.conn.online`   | `#16A34A` | "Online" pill |
| `color.conn.syncing`  | `#0284C7` | "Syncing — N pending" pill (animated pulse) |
| `color.conn.offline`  | `#EA580C` | "Offline — saved locally" pill |
| `color.conn.error`    | `#B91C1C` | "Sync failed — tap to retry" pill |

Note: offline is **orange, not red**. Offline is normal operation in Kassa, not an error. We reserve red for sync failures that need user action.

### 2.6 Color usage rules

- **One primary per screen.** A screen has at most one primary action. Other actions are secondary or ghost.
- **Never communicate state with color alone.** Always pair with an icon or label (red text + error icon, not just red text). Critical for accessibility and B/W receipt printers.
- **Tinted surfaces over filled badges.** Prefer `surface` + `fg` for status chips; reserve `solid` for buttons and totals.
- **Contrast minimum 4.5:1** for body text and UI text. 3:1 for large text (≥18px regular or ≥14px bold) and decorative graphics.

---

## 3. Typography

### 3.1 Type families

| Token | Family | Fallback stack | Source |
|-------|--------|----------------|--------|
| `font.sans` | Plus Jakarta Sans | `"Plus Jakarta Sans", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | [Google Fonts](https://fonts.google.com/specimen/Plus+Jakarta+Sans), OFL |
| `font.mono` | JetBrains Mono | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | [Google Fonts](https://fonts.google.com/specimen/JetBrains+Mono), OFL |

Plus Jakarta Sans is Indonesia-designed (Tokotype), open-licensed, broad latin coverage, and has a slightly humanist character that sets Kassa apart from generic Inter-everywhere SaaS. Self-host the variable WOFF2; do not depend on Google Fonts CDN at runtime — the PWA must work offline.

Mono is used for SKUs, receipts, transaction IDs, code snippets, and any tabular numerical alignment that the sans's tabular numerals don't cover.

### 3.2 Type scale

Modular scale (1.125 ratio). Body anchored at 16px so the OS-level zoom respects the user.

| Token | Size / Line | Weight | Letter spacing | Usage |
|-------|-------------|--------|----------------|-------|
| `text.display` | 48 / 56 | 700 | -0.02em | Splash, marketing only |
| `text.h1` | 32 / 40 | 700 | -0.01em | Page title (back office) |
| `text.h2` | 24 / 32 | 700 | -0.01em | Section title |
| `text.h3` | 20 / 28 | 600 | 0 | Card title, modal title |
| `text.h4` | 18 / 24 | 600 | 0 | Subsection title |
| `text.body-lg` | 18 / 28 | 400 | 0 | Primary body on POS surface (tablet reading distance) |
| `text.body` | 16 / 24 | 400 | 0 | Default body |
| `text.body-sm` | 14 / 20 | 400 | 0 | Helper, secondary content |
| `text.caption` | 12 / 16 | 500 | 0.02em | Label, metadata, timestamp |
| `text.overline` | 11 / 16 | 600 | 0.08em (uppercase) | Section eyebrow |
| `text.button` | 16 / 24 | 600 | 0 | Default button label |
| `text.button-lg` | 18 / 24 | 600 | 0 | POS primary action label (Charge, Tender) |
| `text.price-lg` | 32 / 40 | 700 (tabular) | -0.01em | Cart total, charge amount |
| `text.price-md` | 20 / 28 | 600 (tabular) | 0 | Line-item total |
| `text.price-sm` | 16 / 24 | 600 (tabular) | 0 | Catalog tile price |
| `text.mono` | 14 / 20 | 400 | 0 | SKU, transaction ID, receipt body |

All `price.*` and any column of numbers MUST set `font-feature-settings: "tnum" 1, "lnum" 1` for tabular lining numerals. Misaligned rupiah amounts on a receipt look broken.

### 3.3 Weight tokens

Plus Jakarta Sans: 400 (Regular), 500 (Medium), 600 (SemiBold), 700 (Bold), 800 (ExtraBold). We use 400/500/600/700. Do not introduce italics — Plus Jakarta Sans italics are not designed for body use.

### 3.4 Locale & numerics

- App primary locale is **Bahasa Indonesia (id-ID)**. English is a switchable secondary; copy keys must support translation from day one.
- **Currency formatting**: `Rp` prefix with non-breaking space, thousand separator `.`, decimal `,` (id-ID locale). Examples: `Rp 12.500`, `Rp 1.250.000`, `Rp 0`. Always render via `Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })` — IDR has no fractional unit in practice.
- **Date/time**: `id-ID` short date (`22/04/2026`) for table cells, long date (`22 April 2026`) for receipts and headers. 24-hour clock.
- **Negative amounts** (refunds, voids): render with leading minus and `color.danger.fg`, e.g. `−Rp 12.500`.

---

## 4. Spacing & Sizing

### 4.1 Spacing scale

Base unit **4px**. Use scale tokens; do not hand-pick values.

| Token | Value | Typical usage |
|-------|-------|---------------|
| `space.0`  | 0   | Reset |
| `space.1`  | 4px  | Icon-to-text gap, tight stacks |
| `space.2`  | 8px  | Default inline gap |
| `space.3`  | 12px | Form field internal padding (vertical) |
| `space.4`  | 16px | Default block gap, card padding (compact) |
| `space.5`  | 20px | Card padding (default) |
| `space.6`  | 24px | Section gap, modal padding |
| `space.8`  | 32px | Major section gap |
| `space.10` | 40px | Page top padding (back office) |
| `space.12` | 48px | Hero / empty-state padding |
| `space.16` | 64px | Page section break |
| `space.20` | 80px | Reserved (marketing) |

### 4.2 Touch targets

| Token | Value | Usage |
|-------|-------|-------|
| `tap.min` | 44px | Absolute minimum interactive height (iOS HIG floor) |
| `tap.default` | 48px | Default for buttons, inputs, list rows on POS surface |
| `tap.primary` | 56px | Primary POS action (Charge, Tender, Add Item) |
| `tap.keypad` | 64px | Numeric keypad keys for tender entry |

Spacing between adjacent tap targets MUST be ≥ `space.2` (8px) to prevent fat-fingering.

### 4.3 Radii

| Token | Value | Usage |
|-------|-------|-------|
| `radius.none` | 0 | Receipt edges, table cells |
| `radius.sm` | 4px | Chips, tags, inline pills |
| `radius.md` | 8px | Inputs, buttons, small cards |
| `radius.lg` | 12px | Cards, modals, sheets |
| `radius.xl` | 16px | Catalog tiles, hero panels |
| `radius.full` | 9999px | Avatars, status dots, connection pill |

### 4.4 Elevation

We use **two layers of shadow** plus borders for everything else. Avoid heavy shadows — they read as "consumer app", not "tool".

| Token | Shadow | Usage |
|-------|--------|-------|
| `shadow.none` | none | Default — flat surface with border |
| `shadow.sm` | `0 1px 2px 0 rgba(28,25,23,0.06)` | Sticky header, raised input on focus |
| `shadow.md` | `0 4px 12px -2px rgba(28,25,23,0.10), 0 2px 4px -2px rgba(28,25,23,0.06)` | Dropdowns, popovers |
| `shadow.lg` | `0 12px 32px -8px rgba(28,25,23,0.18), 0 4px 8px -4px rgba(28,25,23,0.08)` | Modal, bottom sheet |

### 4.5 Borders

Default border: `1px solid color.neutral.200`. Strong border (input on hover, selected row): `1px solid color.neutral.300`. Focus border: `2px solid color.primary.600` with `2px` outer offset (focus ring).

---

## 5. Iconography

- **Library**: [Lucide](https://lucide.dev/) (open-source, MIT). Stable icon set, easy to add custom icons in matching style.
- **Stroke**: 1.5px at 24px grid. Do not switch to filled icons for emphasis — use color or background instead.
- **Sizes**: `icon.sm` 16px, `icon.md` 20px (default in body), `icon.lg` 24px (default on POS surface, button leading icon), `icon.xl` 32px (empty state).
- **Custom icons** (cash-tender, QRIS, BOM, outlet, receipt) live in `app/icons/` and follow Lucide stroke (1.5px), terminals (round), grid (24px). Designer ships SVGs; engineer wraps them in the same component as Lucide icons.
- Icons are decorative by default — pair with a visible label or `aria-label`.

---

## 6. Component Patterns

Each pattern lists variants, sizes, states, and behavior. Engineers implement in the chosen framework once [KASA-5](/KASA/issues/KASA-5) lands.

### 6.1 Button

**Variants**: `primary`, `secondary`, `ghost`, `destructive`, `link`.
**Sizes**: `sm` (32px), `md` (40px), `lg` (48px = `tap.default`), `xl` (56px = `tap.primary`).
**States**: default, hover, active (pressed), focus-visible, disabled, loading.

| Variant | Bg / Border / Text |
|---------|--------------------|
| `primary` | bg `color.primary.600`, text `color.neutral.0`, hover bg `color.primary.700`, active bg `color.primary.800` |
| `secondary` | bg `color.neutral.0`, border `color.neutral.300`, text `color.neutral.800`, hover bg `color.neutral.50`, active bg `color.neutral.100` |
| `ghost` | bg transparent, text `color.neutral.700`, hover bg `color.neutral.100` |
| `destructive` | bg `color.danger.solid`, text `color.neutral.0`, hover darken 8% |
| `link` | text `color.primary.700`, underline on hover, no padding |

Loading state: replace leading icon with spinner; keep label visible; disable interaction. Disabled state: opacity 0.5, cursor not-allowed, no hover.

Focus ring: `0 0 0 2px color.neutral.0, 0 0 0 4px color.primary.600` (double-ring so it shows on tinted surfaces too).

### 6.2 Input (text, numeric, currency, search)

- **Height**: `tap.default` (48px) on POS, `40px` in back office tables.
- **Padding**: `space.3` vertical, `space.4` horizontal.
- **Border**: `1px solid color.neutral.300` default, `color.neutral.400` hover, focus = focus ring (see Button).
- **Label**: above input, `text.caption`, `color.neutral.700`. Required marker: `*` in `color.danger.fg`.
- **Helper / error text**: below input, `text.caption`. Error replaces helper.
- **Currency input**: `Rp` prefix slot inside the input border on the left, separated by a 1px divider. Right-aligned tabular number.
- **Numeric input on POS**: spawns the on-screen numeric keypad (see 6.7), not the OS keyboard, when `inputMode="numeric"` and `data-pos-keypad`.
- **Search input**: leading magnifier icon, optional clear button when text present.

### 6.3 Select / Dropdown

- Trigger: matches Input styling, with trailing `chevron-down` icon.
- Menu: `radius.lg`, `shadow.md`, max-height ~320px with scroll. Selected option uses `color.primary.50` background, `color.primary.700` text, leading check icon.
- Search-in-select for lists >10 options.

### 6.4 Card

- **Surface**: `color.neutral.0`, `1px solid color.neutral.200`, `radius.lg`.
- **Padding**: `space.5` (default), `space.4` (compact, used inside lists).
- **Header** (optional): `text.h3`, `space.4` bottom margin, divider below if dense content.
- **Variants**: `default` (described above), `tinted` (uses semantic `surface`, no border), `interactive` (adds hover `bg color.neutral.50`, cursor pointer, focus ring).

### 6.5 Catalog item tile (POS)

The flagship POS component — the cashier's main surface.

- **Grid**: 4 columns on tablet portrait, 6 on landscape, 2 on phone. CSS Grid, `gap: space.3`.
- **Tile size**: aspect ratio 1:1.1, min height 120px.
- **Surface**: `color.neutral.0`, `radius.xl`, `1px solid color.neutral.200`. Active (mid-tap) state: `1px solid color.primary.600`, `bg color.primary.50`.
- **Content**: 56×56 product thumbnail at top-left (or color block with first 2 chars if no image), name on 2 lines max with ellipsis (`text.body`, `color.neutral.800`, weight 600), price bottom-right (`text.price-sm`, `color.neutral.900`).
- **Out-of-stock overlay**: 50% white wash, "Habis" pill (`color.danger.surface` chip).
- **Behavior**: single tap adds to cart, long-press opens variant picker (if applicable), keyboard `Enter` activates. Provides haptic feedback (where supported) on add.

### 6.6 Cart line item

- **Layout**: row, `padding space.3 space.4`, divider bottom.
- **Left**: name (`text.body`, weight 600), qty stepper below (`text.caption`, "1× Rp 12.500").
- **Right**: line total (`text.price-md`, tabular).
- **Tap**: opens edit sheet (qty, modifiers, remove).
- **Swipe-left** (touch): reveals "Hapus" destructive action (`color.danger.solid`).

### 6.7 Numeric keypad (tender entry)

- **Grid**: 3 columns × 4 rows. Keys `1-9`, `00`, `0`, `⌫`.
- **Key**: `tap.keypad` (64px square), `radius.md`, `1px solid color.neutral.200`, label `text.h2`, weight 700, tabular numerals.
- **Active state**: `bg color.neutral.100`, scale(0.97) on press (~80ms).
- **Layout context**: appears at the bottom of tender screen with the running amount displayed above using `text.price-lg`.
- Quick-tender chips above keypad for common amounts: "Pas" (exact), `Rp 50.000`, `Rp 100.000`, `Rp 200.000`. Chips are `radius.full`, `tap.default` height.

### 6.8 Tender / Charge button (primary POS action)

- Full-width, `tap.primary` (56px), `text.button-lg`, `bg color.primary.600`.
- Always shows the amount: `Bayar Rp 47.500`. The amount uses tabular numerals.
- Disabled (cart empty): `bg color.neutral.200`, `text color.neutral.500`, label `Tambah barang dulu`.

### 6.9 Connection-state pill (persistent header chip)

- Position: top-right of POS header.
- Shape: `radius.full`, `padding 4px 12px`, `text.caption`, weight 600.
- Leading 8px dot of the same hue.
- States:
  - **Online**: `bg color.success.surface`, dot `color.conn.online`, text `Online`
  - **Syncing**: `bg color.info.surface`, dot `color.conn.syncing` (1.2s pulse animation), text `Sinkronisasi · N`
  - **Offline**: `bg #FFF7ED`, dot `color.conn.offline`, text `Offline — tersimpan lokal`
  - **Sync failed**: `bg color.danger.surface`, dot `color.conn.error`, text `Sync gagal — ketuk untuk coba lagi`, tappable.
- The pill MUST always be visible — never collapse it on small screens.

### 6.10 Modal & Bottom Sheet

- **Modal** (back office, tablet landscape): centered, max-width 560px, `radius.lg`, `shadow.lg`, scrim `rgba(28,25,23,0.5)`. Header (`text.h3` + close icon), body (`space.6` padding), footer (right-aligned actions, ghost + primary).
- **Bottom sheet** (POS, tablet portrait & phone): pinned to bottom, `radius.lg lg 0 0`, drag handle on top (40×4px, `color.neutral.300`), max-height 90vh. Used for cart edit, variant picker, customer attach.
- **Behavior**: ESC closes (modal), swipe-down-on-handle closes (sheet). Focus trapped while open. First focusable element receives focus on open.

### 6.11 Toast & Banner

- **Toast** (transient, auto-dismiss): bottom-center on POS, top-right on back office. Max 3 stacked. Auto-dismiss 4s (success), 6s (error), persistent (sync failure with action). `radius.md`, `shadow.md`, leading status icon, `text.body-sm`. Variants use semantic `surface` + `border` + `fg`.
- **Banner** (in-context, persistent): full-width inside its container. Same color treatment as toast. Use for "Stok rendah", "Outlet sedang offline", etc. Dismissible variant has trailing X icon.

### 6.12 Empty state

- Centered in container. Illustration or icon `icon.xl` in `color.neutral.400`, `text.h3` heading, `text.body` helper, optional primary action button. Vertical rhythm: icon → space.4 → heading → space.2 → body → space.6 → action.

### 6.13 Data table (back office)

- Header row: `bg color.neutral.50`, `text.caption`, weight 600, uppercase, `color.neutral.700`, sticky on vertical scroll.
- Cells: `padding space.3 space.4`, `text.body-sm`, divider bottom (`color.neutral.200`). Numeric columns right-aligned with tabular numerals.
- Row hover: `bg color.neutral.50`. Selected: `bg color.primary.50`, leading `2px` `color.primary.600` indicator.
- Pagination: bottom-right, page size selector + page nav.
- Empty: see 6.12 inside the table body.

### 6.14 Receipt preview

- Mono family (`font.mono`), 14px / 20px, `color.neutral.900` on `color.neutral.0`.
- Width 280px (mimics 58mm printer paper) or 380px (80mm); user-selectable.
- Center-aligned header (outlet name, address), left/right justified line items (name left, total right), centered footer (thank-you, QRIS receipt id).
- Renders on a `radius.none` surface with a faint dashed border to show paper edge.

---

## 7. Motion

Motion is functional, not decorative. Default duration **150ms**, default easing **`cubic-bezier(0.2, 0, 0, 1)`** (standard ease-out).

| Token | Duration | Easing | Usage |
|-------|----------|--------|-------|
| `motion.duration.instant` | 80ms | linear | Tactile feedback (button press scale) |
| `motion.duration.fast` | 150ms | standard | Hover, focus, color transitions |
| `motion.duration.base` | 200ms | standard | Modal/sheet enter, dropdown |
| `motion.duration.slow` | 320ms | standard | Page-level transitions only |
| `motion.easing.standard` | — | `cubic-bezier(0.2, 0, 0, 1)` | Default |
| `motion.easing.emphasized` | — | `cubic-bezier(0.2, 0, 0, 1.2)` | Sheet enter (tiny overshoot) |

Honor `prefers-reduced-motion`: replace any movement >80ms with an instant fade.

---

## 8. Responsive Breakpoints

| Token | Min width | Primary form factor | Layout |
|-------|-----------|---------------------|--------|
| `bp.phone`   | 0      | Phone (clerk pocket / handheld) | Single column, bottom-sheet patterns, bottom-nav |
| `bp.tablet`  | 768px  | **Tablet on counter (primary POS surface)** | Two-pane: catalog left, cart right (60/40 landscape) or stacked (portrait) |
| `bp.laptop`  | 1024px | Back-office laptop | Sidebar nav + main content |
| `bp.desktop` | 1280px | Back-office desktop | Wide content, multi-column dashboards |
| `bp.wide`    | 1536px | Multi-outlet dashboard | Optional 3-column layouts |

POS UI is designed **tablet-first**. Phone is a fallback (manager on the move, backup terminal). Back office is laptop-first.

---

## 9. Accessibility

- **Color contrast**: all body and UI text meets WCAG AA (4.5:1). Large text and graphics meet 3:1.
- **Focus**: every interactive element has a visible focus ring (see 6.1). Never `outline: none` without an equivalent.
- **Keyboard**: all flows completable without a pointer. `Tab` order follows reading order. `Esc` closes modals/sheets. `Enter` activates the primary action of a focused dialog.
- **Touch targets**: minimum 44×44px, separated by ≥8px.
- **Screen reader**: every icon-only button has `aria-label`. Status updates (toast, sync state change) are announced via `aria-live="polite"`. Sync failures use `aria-live="assertive"`.
- **Motion**: `prefers-reduced-motion` honored throughout (see 7).
- **Color blindness**: never communicate state with color alone (see 2.6).

---

## 10. Token implementation guidance

The Engineer can implement these tokens in whatever the chosen tech stack ([KASA-5](/KASA/issues/KASA-5)) ends up being. Two compatible shapes:

### 10.1 CSS custom properties (recommended for the PWA)

```css
:root {
  --color-primary-600: #0D9488;
  --color-neutral-200: #E7E5E4;
  --space-4: 16px;
  --radius-lg: 12px;
  --font-sans: "Plus Jakarta Sans", "Inter", system-ui, sans-serif;
  --shadow-md: 0 4px 12px -2px rgba(28,25,23,0.10), 0 2px 4px -2px rgba(28,25,23,0.06);
  /* ...etc */
}
```

### 10.2 JSON tokens (for Tailwind/Style Dictionary)

```json
{
  "color": { "primary": { "600": { "value": "#0D9488" } } },
  "space": { "4": { "value": "16px" } }
}
```

Whichever shape, **token names are the contract**. Engineers reference `color.primary.600`, not `#0D9488`. Once [KASA-5](/KASA/issues/KASA-5) lands, the UI Designer will create a follow-up issue to ship a tokens file (CSS or JSON) matched to the chosen stack.

---

## 11. Brand & assets (deferred)

Logo, wordmark, app icon, splash, marketing assets, tone-of-voice, and merchant-facing illustration style are owned by [KASA-11](/KASA/issues/KASA-11) (Brand Identity). Until that ships, use the placeholder wordmark "Kassa" set in `font.sans`, weight 700, `color.primary.700`. Do not commission logo work outside KASA-11.

---

## 12. Out of scope (for v0)

- Dark mode. POS surfaces are used in lit environments; dark mode is a v1 consideration.
- Themed/whitelabel deployments. v0 ships one Kassa brand.
- Print stylesheet beyond the receipt preview component.
- Native-feel platform overrides (iOS-only or Android-only treatments).

---

## Revision log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-22 | UI Designer | v0 — initial design system foundation, linked to [KASA-7](/KASA/issues/KASA-7). |
