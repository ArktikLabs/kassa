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
  "pwa.updateAvailable": "Update tersedia — muat ulang",
  "pwa.updateAccept": "Muat ulang",
  "pwa.offlineReady": "Siap untuk dipakai offline",
  "enrol.heading": "Enrol perangkat",
  "enrol.intro":
    "Daftarkan tablet ini ke outlet Anda untuk mulai menerima pesanan. Langkah ini akan diisi pada ticket enrolment berikutnya.",
  "enrol.cta": "Enrol perangkat",
  "catalog.heading": "Katalog",
  "catalog.aria": "Katalog produk",
  "catalog.loading": "Memuat katalog…",
  "catalog.grid.aria": "Daftar produk",
  "catalog.tile.aria": "{name}, harga {price}. Ketuk untuk menambah.",
  "catalog.tile.ariaOutOfStock": "{name}, habis. Tidak tersedia.",
  "catalog.tile.outOfStock": "Habis",
  "catalog.empty.heading": "Belum ada produk",
  "catalog.empty.body":
    "Tambahkan produk di back office — katalog akan muncul setelah sinkronisasi berikutnya.",
  "catalog.variant.title": "Varian untuk {name}",
  "catalog.variant.placeholder":
    "Pemilih varian akan diisi ketika data varian tersedia.",
  "catalog.variant.close": "Tutup",
  "cart.heading": "Keranjang",
  "cart.aria": "Keranjang",
  "cart.empty.heading": "Keranjang kosong",
  "cart.empty.body": "Ketuk produk untuk mulai menambah.",
  "cart.totals.subtotal": "Subtotal",
  "cart.charge.empty": "Tambah barang dulu",
  "cart.charge.pay": "Bayar {total}",
  "cart.row.qtyLine": "{quantity}× {unit}",
  "cart.row.editAria":
    "{name}, {quantity} unit, total {total}. Ketuk untuk ubah jumlah.",
  "cart.row.remove": "Hapus",
  "cart.row.removeAria": "Hapus {name} dari keranjang",
  "cart.edit.title": "Ubah jumlah {name}",
  "cart.edit.quantity": "Jumlah",
  "cart.edit.preview": "Total baris {total}",
  "cart.edit.keypadAria": "Keypad jumlah",
  "cart.edit.apply": "Simpan",
  "cart.edit.cancel": "Batal",
  "cart.edit.remove": "Hapus baris",
  "keypad.aria": "Keypad angka",
  "keypad.backspace": "Hapus digit terakhir",
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
  "admin.sync.heading": "Sinkronisasi data",
  "admin.sync.phase": "Status",
  "admin.sync.table": "Tabel aktif",
  "admin.sync.lastSuccess": "Terakhir sukses",
  "admin.sync.error": "Error terakhir",
  "admin.sync.refresh": "Segarkan data",
  "admin.sync.refreshing": "Menyegarkan…",
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
  "pwa.updateAvailable": "Update available — reload to apply",
  "pwa.updateAccept": "Reload",
  "pwa.offlineReady": "Ready to use offline",
  "enrol.heading": "Enrol device",
  "enrol.intro":
    "Register this tablet to your outlet to start taking orders. This step will be filled in by the upcoming enrolment ticket.",
  "enrol.cta": "Enrol device",
  "catalog.heading": "Catalog",
  "catalog.aria": "Product catalog",
  "catalog.loading": "Loading catalog…",
  "catalog.grid.aria": "Product grid",
  "catalog.tile.aria": "{name}, price {price}. Tap to add.",
  "catalog.tile.ariaOutOfStock": "{name}, out of stock. Unavailable.",
  "catalog.tile.outOfStock": "Out of stock",
  "catalog.empty.heading": "No products yet",
  "catalog.empty.body":
    "Add products in the back office — they will appear after the next sync.",
  "catalog.variant.title": "Variants for {name}",
  "catalog.variant.placeholder":
    "Variant picker will populate once variant data is available.",
  "catalog.variant.close": "Close",
  "cart.heading": "Cart",
  "cart.aria": "Cart",
  "cart.empty.heading": "Cart is empty",
  "cart.empty.body": "Tap a product to start adding.",
  "cart.totals.subtotal": "Subtotal",
  "cart.charge.empty": "Add items first",
  "cart.charge.pay": "Pay {total}",
  "cart.row.qtyLine": "{quantity}× {unit}",
  "cart.row.editAria":
    "{name}, {quantity} units, total {total}. Tap to change quantity.",
  "cart.row.remove": "Remove",
  "cart.row.removeAria": "Remove {name} from cart",
  "cart.edit.title": "Edit quantity for {name}",
  "cart.edit.quantity": "Quantity",
  "cart.edit.preview": "Line total {total}",
  "cart.edit.keypadAria": "Quantity keypad",
  "cart.edit.apply": "Save",
  "cart.edit.cancel": "Cancel",
  "cart.edit.remove": "Remove line",
  "keypad.aria": "Number keypad",
  "keypad.backspace": "Delete last digit",
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
  "admin.sync.heading": "Data sync",
  "admin.sync.phase": "Status",
  "admin.sync.table": "Active table",
  "admin.sync.lastSuccess": "Last success",
  "admin.sync.error": "Last error",
  "admin.sync.refresh": "Refresh data",
  "admin.sync.refreshing": "Refreshing…",
};

const CATALOGUES: Record<Locale, MessageMap> = {
  "id-ID": id,
  en,
};

export function messagesFor(locale: Locale): MessageMap {
  return CATALOGUES[locale] ?? CATALOGUES[FALLBACK_LOCALE];
}
