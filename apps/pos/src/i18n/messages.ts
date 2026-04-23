/*
 * v0 message catalogues. Bahasa Indonesia (id-ID) is the primary copy
 * source per DESIGN-SYSTEM §3.4; English is a switchable secondary so
 * every translatable string lives behind a key from day one.
 *
 * As the app grows we will extract these to .json catalogues and run
 * them through formatjs CLI; for the M2 shell the inline shape keeps
 * the bundle small and the test set legible.
 */

export const SUPPORTED_LOCALES = ["id-ID", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "id-ID";
export const FALLBACK_LOCALE: Locale = "en";

type MessageMap = Record<string, string>;

const id: MessageMap = {
  "app.name": "Kassa POS",
  "nav.catalog": "Katalog",
  "nav.cart": "Keranjang",
  "nav.tender.cash": "Tunai",
  "nav.enrol": "Enrol",
  "nav.admin": "Admin",
  "conn.online": "Online",
  "conn.syncing": "Sinkronisasi · {count}",
  "conn.offline": "Offline — tersimpan lokal",
  "conn.error": "Sync gagal — ketuk untuk coba lagi",
  "enrol.heading": "Enrol perangkat",
  "enrol.intro":
    "Daftarkan tablet ini ke outlet Anda untuk mulai menerima pesanan. Langkah ini akan diisi pada ticket enrolment berikutnya.",
  "enrol.cta": "Enrol perangkat",
  "catalog.heading": "Katalog",
  "catalog.placeholder":
    "Tile produk akan muncul di sini. Shell ini hanya scaffolding — logika katalog diisi di ticket berikutnya.",
  "cart.heading": "Keranjang",
  "cart.placeholder":
    "Isi keranjang dan tombol Bayar akan ditambahkan di ticket cart berikutnya.",
  "tender.cash.heading": "Bayar Tunai",
  "tender.cash.placeholder":
    "Keypad dan perhitungan kembalian akan ditambahkan di ticket tender berikutnya.",
  "receipt.heading": "Struk",
  "receipt.id": "ID: {id}",
  "receipt.placeholder":
    "Tampilan struk 58mm/80mm diisi di ticket receipt berikutnya.",
  "admin.heading": "Admin",
  "admin.placeholder":
    "Pengaturan outlet, kasir, dan perangkat diisi di ticket admin berikutnya.",
};

const en: MessageMap = {
  "app.name": "Kassa POS",
  "nav.catalog": "Catalog",
  "nav.cart": "Cart",
  "nav.tender.cash": "Cash",
  "nav.enrol": "Enrol",
  "nav.admin": "Admin",
  "conn.online": "Online",
  "conn.syncing": "Syncing · {count}",
  "conn.offline": "Offline — saved locally",
  "conn.error": "Sync failed — tap to retry",
  "enrol.heading": "Enrol device",
  "enrol.intro":
    "Register this tablet to your outlet to start taking orders. This step will be filled in by the upcoming enrolment ticket.",
  "enrol.cta": "Enrol device",
  "catalog.heading": "Catalog",
  "catalog.placeholder":
    "Product tiles will appear here. This shell is scaffolding only — catalog logic ships in a follow-up ticket.",
  "cart.heading": "Cart",
  "cart.placeholder":
    "Cart contents and the Pay button arrive in the cart ticket.",
  "tender.cash.heading": "Cash payment",
  "tender.cash.placeholder":
    "Keypad and change calculation arrive in the tender ticket.",
  "receipt.heading": "Receipt",
  "receipt.id": "ID: {id}",
  "receipt.placeholder":
    "58mm/80mm receipt layout arrives in the receipt ticket.",
  "admin.heading": "Admin",
  "admin.placeholder":
    "Outlet, cashier and device settings arrive in the admin ticket.",
};

const CATALOGUES: Record<Locale, MessageMap> = {
  "id-ID": id,
  en,
};

export function messagesFor(locale: Locale): MessageMap {
  return CATALOGUES[locale] ?? CATALOGUES[FALLBACK_LOCALE];
}
