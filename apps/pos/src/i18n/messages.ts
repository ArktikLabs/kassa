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
    "Masukkan kode 8 karakter dari Back Office, atau pindai QR-nya, untuk menautkan tablet ini ke outlet Anda.",
  "enrol.code.label": "Kode enrolment",
  "enrol.code.placeholder": "ABCD2345",
  "enrol.code.hint":
    "Tanyakan pada pemilik warung. Kode berlaku 15 menit dan hanya bisa dipakai sekali.",
  "enrol.cta": "Hubungkan perangkat",
  "enrol.cta.submitting": "Menghubungkan…",
  "enrol.cta.scan": "Pindai QR",
  "enrol.cta.scan_unsupported":
    "Peramban ini belum mendukung pemindai QR. Masukkan kode secara manual.",
  "enrol.qr.heading": "Arahkan kamera ke QR",
  "enrol.qr.close": "Tutup",
  "enrol.qr.hint": "Pastikan QR terlihat penuh dan pencahayaan cukup.",
  "enrol.qr.dialog_label": "Pemindai kode QR enrolment",
  "enrol.qr.permission":
    "Tidak bisa mengakses kamera. Izinkan akses kamera atau masukkan kode manual.",
  "enrol.qr.camera_failed":
    "Kamera tidak dapat dibuka. Masukkan kode manual sebagai gantinya.",
  "enrol.qr.unsupported":
    "Peramban ini tidak mendukung pemindai QR. Masukkan kode manual.",
  "enrol.toast.success": "Perangkat terhubung ke {outlet}",
  "enrol.error.retry": "Coba lagi",
  "enrol.error.code_format": "Kode harus 8 karakter (huruf besar dan angka, tanpa O/I/L/U).",
  "enrol.error.code_not_found": "Kode tidak dikenal. Periksa kembali dan coba lagi.",
  "enrol.error.code_expired": "Kode sudah kedaluwarsa. Minta kode baru di Back Office.",
  "enrol.error.code_already_used":
    "Kode sudah dipakai perangkat lain. Minta kode baru di Back Office.",
  "enrol.error.bad_request": "Kode tidak valid.",
  "enrol.error.rate_limited": "Terlalu banyak percobaan. Tunggu sebentar dan coba lagi.",
  "enrol.error.network_error":
    "Tidak ada koneksi. Sambungkan ke internet untuk mendaftarkan perangkat.",
  "enrol.error.unknown": "Terjadi kesalahan tak terduga. Coba lagi sebentar lagi.",
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
  "admin.placeholder": "Pengaturan outlet, kasir, dan perangkat.",
  "admin.device.heading": "Perangkat",
  "admin.device.outlet": "Outlet",
  "admin.device.merchant": "Merchant",
  "admin.device.id": "Device ID",
  "admin.device.unenrolled":
    "Perangkat ini belum terdaftar. Buka /enrol untuk menghubungkannya.",
  "admin.reset.heading": "Reset perangkat",
  "admin.reset.description":
    "Menghapus kredensial perangkat dan cache lokal. Anda perlu kode enrolment baru dari Back Office untuk menghubungkan ulang.",
  "admin.reset.cta": "Reset perangkat",
  "admin.reset.confirm": "Ya, reset",
  "admin.reset.cancel": "Batal",
  "admin.reset.confirming": "Mereset…",
  "admin.reset.toast": "Perangkat di-reset. Masukkan kode enrolment baru untuk melanjutkan.",
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
    "Enter the 8-character code from the Back Office, or scan its QR, to link this tablet to your outlet.",
  "enrol.code.label": "Enrolment code",
  "enrol.code.placeholder": "ABCD2345",
  "enrol.code.hint":
    "Ask the merchant owner. Codes expire after 15 minutes and can only be used once.",
  "enrol.cta": "Connect device",
  "enrol.cta.submitting": "Connecting…",
  "enrol.cta.scan": "Scan QR",
  "enrol.cta.scan_unsupported":
    "This browser cannot scan QR codes. Enter the code manually.",
  "enrol.qr.heading": "Point the camera at the QR",
  "enrol.qr.close": "Close",
  "enrol.qr.hint": "Frame the full QR code and make sure there's enough light.",
  "enrol.qr.dialog_label": "Enrolment QR scanner",
  "enrol.qr.permission":
    "Can't access the camera. Grant camera permission or enter the code manually.",
  "enrol.qr.camera_failed":
    "Couldn't open the camera. Enter the code manually instead.",
  "enrol.qr.unsupported":
    "This browser doesn't support the QR scanner. Enter the code manually.",
  "enrol.toast.success": "Device connected to {outlet}",
  "enrol.error.retry": "Try again",
  "enrol.error.code_format":
    "The code must be 8 characters (upper-case letters and digits, no O/I/L/U).",
  "enrol.error.code_not_found": "Code not recognised. Double-check and try again.",
  "enrol.error.code_expired": "Code has expired. Generate a new one in Back Office.",
  "enrol.error.code_already_used":
    "Code already used on another device. Generate a new one in Back Office.",
  "enrol.error.bad_request": "Invalid code.",
  "enrol.error.rate_limited": "Too many attempts. Wait a moment and try again.",
  "enrol.error.network_error":
    "No connection. Go online to enrol this device.",
  "enrol.error.unknown": "Unexpected error. Try again shortly.",
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
  "admin.placeholder": "Outlet, cashier and device settings.",
  "admin.device.heading": "Device",
  "admin.device.outlet": "Outlet",
  "admin.device.merchant": "Merchant",
  "admin.device.id": "Device ID",
  "admin.device.unenrolled":
    "This device isn't enrolled yet. Visit /enrol to connect it.",
  "admin.reset.heading": "Reset device",
  "admin.reset.description":
    "Clears this device's credentials and local cache. You will need a new enrolment code from the Back Office to reconnect.",
  "admin.reset.cta": "Reset device",
  "admin.reset.confirm": "Yes, reset",
  "admin.reset.cancel": "Cancel",
  "admin.reset.confirming": "Resetting…",
  "admin.reset.toast": "Device reset. Enter a new enrolment code to continue.",
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
