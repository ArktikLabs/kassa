# id-ID copy review — pre-pilot pass (KASA-328)

Pre-pilot single-pass review of every user-facing string in `apps/pos/src/i18n/messages.ts` and `apps/back-office/src/i18n/messages.ts`. id-ID is the primary locale (DEFAULT_LOCALE); en is the fallback. Reviewer: Frontend Engineer, 2026-05-25.

The review confirmed the catalogues are already in natural Bahasa Indonesia — most strings ship as-is. What follows is the **glossary** (locked terminology for future strings) and the **change list** (only the entries this pass actually touched). The unchanged entries do not need a row here; consult `messages.ts` for canonical text.

## 1. Glossary — warung-native phrasing

Lock these to keep new screens (modifiers KASA-325, stock movements KASA-326, sales summary KASA-327, future M4+) consistent. If a future string needs a domain term not in this table, extend the table in the same PR.

| Domain concept | en | **id-ID (locked)** | Notes |
| --- | --- | --- | --- |
| cashier | Cashier | **Kasir** | Person operating the POS. Capitalised when it's a role label, lowercase as a noun. |
| outlet | Outlet | **Outlet** | The merchant-facing term — both warung owners and Midtrans onboarding use "outlet". "Cabang" is reserved for chains and is out of scope for v0. |
| device / tablet | Device | **Perangkat** | Used in enrolment + admin. Avoid "tablet" in copy (the merchant may run on a phone). |
| tender / payment method | Tender | **Pembayaran** | "Metode pembayaran" for filter labels. "Tender" stays English in code only. |
| cash | Cash | **Tunai** | Both the tender type and the receipt label. |
| QRIS — dynamic | QRIS (dynamic) | **QRIS dinamis** | |
| QRIS — static | QRIS (static) | **QRIS statis** | |
| modifier (KASA-325) | Modifier | **Variasi** | "Variasi" reads natural for size/temp/sugar; reserve "modifier" for code identifiers. |
| receive stock (KASA-326) | Receive stock | **Terima stok** | Imperative form for buttons; "Penerimaan stok" for headings. |
| adjust stock (KASA-326) | Adjust stock | **Sesuaikan stok** | "Penyesuaian stok" for headings. |
| void | Void | **Pembatalan** (noun) / **Batalkan** (verb) | Already canonical in `receipt.pembatalan.banner` + `void.cta`. |
| shift | Shift | **Shift** | Kept as "shift" — pilot merchants use the loanword. "Sesi kasir" reads stilted. |
| end-of-day | End-of-day | **Tutup hari** | "Tutup" (verb) on the CTA, "Tutup hari" (noun phrase) for headings. |
| sale | Sale | **Transaksi** | "Penjualan" only for aggregate ("Riwayat penjualan", "Belum ada penjualan"). |
| reprint | Reprint | **Cetak ulang** | |
| reset device | Reset device | **Reset perangkat** | "Reset" stays English (loanword in widespread merchant use). |
| variance | Variance | **Selisih** | Locked across EOD + reconciliation. Avoid "varians" (technical loan). |
| reconciliation | Reconciliation | **Rekonsiliasi** | Long but locked — merchants see this in monthly bookkeeping context. |
| merchant | Merchant | **Merchant** | Loanword — already canonical in `admin.device.merchant`, `settings.heading`. |
| owner | Owner | **Pemilik** | |
| manager | Manager | **Manajer** | |
| sold out | Sold out | **Habis** | Short, fits chip-style badges. |

### Number + date formatting

Locked across both apps:

- **Rupiah**: `new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })` — produces `Rp 12.500`. Helpers: `formatIdr()` in `apps/pos/src/shared/money/index.ts`, `formatRupiah()` in `apps/back-office/src/lib/format.ts`. **No `"Rp "` string literals in `apps/**/src/**` source.**
- **Date / datetime**: `new Intl.DateTimeFormat("id-ID", …)`. For an ISO storage round-trip (e.g. business date keys), keep the explicit `"en-CA"` locale — it yields YYYY-MM-DD and is unaffected by the merchant's locale toggle.
- **toLocaleString without an explicit locale is banned** — always pass `"id-ID"` or the active `intl.locale`.

## 2. Pass C — rupiah + date formatter cleanups (applied)

| Location | Before | After | Why |
| --- | --- | --- | --- |
| `apps/pos/src/i18n/messages.ts` | `tender.cash.chip.50k`/`100k`/`200k` = `"Rp 50.000"` etc. (id + en) | **Removed.** `QuickTenderChips.tsx` derives the visible label via `formatIdr(chip.amountIdr)`; the message strings were dead weight and tripped the grep-gate. The `chip.pas` ("Pas" / "Exact") key stays — it is the only label still looked up via `intl.formatMessage`. | Dead literal + grep-gate violation. |
| `apps/pos/src/i18n/messages.ts` | `help.s5.body` (id): "Target varians: Rp 0." | "Target selisih: nol rupiah." | Glossary: "selisih" not "varians"; no literal `Rp` in source. |
| `apps/pos/src/i18n/messages.ts` | `help.s5.body` (en): "Variance target: Rp 0." | "Variance target: zero rupiah." | Mirrors id; removes literal `Rp`. |
| `apps/back-office/src/routes/admin.sales.tsx:561` | `new Date(sale.createdAt).toLocaleString()` (no locale) | `…toLocaleString(intl.locale, { dateStyle: "short", timeStyle: "short" })` | Bare `toLocaleString` honours the browser locale, not the app's. Sale detail row would have shown en-US dates on an en-US browser even with the app set to id-ID. |
| `apps/back-office/src/routes/devices.tsx:34` | `new Date(r.lastSeenAt).toLocaleString()` | `…toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })` | Same. |
| `apps/back-office/src/routes/devices.tsx:68` | `new Date(c.expiresAt).toLocaleString()` | `…toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })` | Same. |

After this pass, `apps/pos/src/**` and `apps/back-office/src/**` contain no `"Rp "` literal — verify with:

```
rg -n 'Rp ' apps/pos/src apps/back-office/src
```

Tests, comments, and server-side fixtures still mention `Rp` (e.g. `apps/api/test/**`, `apps/back-office/src/routes/admin.dashboard.tsx` doc-comment) — out of scope for a pre-pilot UI pass.

## 3. Pass A + B — copy improvements (applied)

Small wording fixes flagged during the read-through. Behaviour unchanged.

| Key | Before (id) | After (id) | Why |
| --- | --- | --- | --- |
| `enrol.error.unknown` | "Terjadi kesalahan tak terduga. Coba lagi sebentar lagi." | "Terjadi kesalahan tak terduga. Coba lagi nanti." | "sebentar lagi" reads like a wait instruction; "coba lagi nanti" is the merchant-natural retry phrasing. |
| `eod.error.unknown` | "Gagal menutup hari. Coba lagi sebentar lagi." | "Gagal menutup hari. Coba lagi nanti." | Same. |
| `tender.qris.error.amount_mismatch` | "Nominal pembayaran tidak cocok dengan total. Hubungi pelanggan dan coba lagi." | "Nominal pembayaran tidak sesuai dengan total. Hubungi pelanggan lalu coba lagi." | "tidak sesuai" is the standard receipt-mismatch phrasing in Indonesian banking copy; "lalu" sequences the actions more naturally than "dan". |
| `void.field.reason.placeholder` | "Contoh: salah input item" | "Contoh: salah input barang" | Glossary: warung clerks say "barang" for stock items; "item" is dev shorthand. |
| `void.error.unsynced` | "Transaksi belum sampai di server. Tunggu sinkronisasi selesai lalu coba lagi." | "Transaksi belum terkirim ke server. Tunggu sinkronisasi selesai lalu coba lagi." | "belum terkirim" is more concrete than "belum sampai" for a clerk facing a queued sale. |
| `admin.attention.description` | "Transaksi berikut ditolak server dan perlu Anda kirim ulang." | "Transaksi berikut ditolak server. Kirim ulang sebelum tutup hari." | Adds the consequence (blocks EOD) — pilot ops asked for it explicitly. |

Back-office id-side copy was already natural after the M3 polish (KASA-249, KASA-251, KASA-282). No id strings change in `apps/back-office/src/i18n/messages.ts`.

## 4. en-fallback gap — dashboard.* keys were missing

`apps/back-office/src/i18n/messages.ts` ships `dashboard.*` keys in the id catalogue (added in KASA-237) but not in the en catalogue. When a user toggles to en, the dashboard renders the raw key text ("dashboard.tile.gross") instead of a string. Added the en mirror in this PR so the fallback is honest — same shape as the id rows, English copy following the existing en tone.

| Added en key | Value |
| --- | --- |
| `dashboard.heading` | "Daily dashboard" |
| `dashboard.subheading` | "Sales summary for outlet owners and managers. Updates as sale sync events arrive from the POS." |
| `dashboard.outlet.all` | "All outlets" |
| `dashboard.outlet.label` | "Outlet" |
| `dashboard.scope.today` | "Today" |
| `dashboard.scope.yesterday` | "Yesterday" |
| `dashboard.scope.last_7_days` | "Last 7 days" |
| `dashboard.tile.gross` | "Gross revenue" |
| `dashboard.tile.net` | "Net revenue (after PPN)" |
| `dashboard.tile.sale_count` | "Sales" |
| `dashboard.tile.average_ticket` | "Average ticket" |
| `dashboard.tile.tender_mix` | "Tender mix" |
| `dashboard.tender.cash` | "Cash" |
| `dashboard.tender.qris_dynamic` | "QRIS (dynamic)" |
| `dashboard.tender.qris_static` | "QRIS (static)" |
| `dashboard.top_items.by_revenue` | "Top items (revenue)" |
| `dashboard.top_items.by_quantity` | "Top items (quantity)" |
| `dashboard.top_items.col.name` | "Item" |
| `dashboard.top_items.col.revenue` | "Revenue" |
| `dashboard.top_items.col.quantity` | "Sold" |
| `dashboard.empty` | "No sales yet" |
| `dashboard.empty.subheading` | "As soon as the first sale closes today, this summary fills in automatically." |
| `dashboard.error.heading` | "Failed to load dashboard" |
| `dashboard.error.body` | "Reload the page. If the issue persists, contact the Kassa team." |
| `dashboard.loading` | "Loading summary…" |

## 5. Out of scope

- `apps/api/**`, `apps/back-office/test/**`, `apps/pos/src/features/**.test.ts` — server fixtures and test assertions use `Rp` deliberately to mirror the receipt strings they verify. Not user-facing.
- `apps/back-office/src/routes/admin.dashboard.tsx` line 31 — a doc-comment mentioning `"Rp 0"` for the day-zero design rationale. Stays.
- en-locale audit beyond the dashboard fallback gap above — en is the secondary locale; M5+ will add a translator pass when an English-speaking pilot lands.
- Multi-locale infrastructure (per `KASA-328` description "out of scope").
