# Panduan Onboarding Kassa

_Untuk pemilik warung, kopi, atau outlet F&B yang baru pertama kali memakai Kassa. Versi cetak dan versi PWA (`/help` di tablet) sumbernya satu file ini._

> **Target waktu:** dari buat akun sampai transaksi pertama **kurang dari 15 menit**.
> **Bahasa:** id-ID. **Kertas cetak:** A4, ≤ 8 halaman.
> **Sumber:** [VISION.md](../docs/VISION.md), [ROADMAP.md](./ROADMAP.md). Issue [KASA-69](/KASA/issues/KASA-69).

---

## Ringkasan

Kassa adalah aplikasi kasir offline-first. Anda bisa jualan walau internet putus — semua transaksi tersimpan di tablet dan dikirim ke server saat koneksi pulih. Panduan ini memandu Anda dari nol sampai transaksi pertama keluar dari printer.

**Yang akan Anda lakukan, urut:**

1. Buat akun pemilik di Back Office.
2. Tambah outlet pertama.
3. Enrol (daftarkan) tablet kasir ke outlet itu.
4. Sambungkan printer Bluetooth.
5. Tambah satu item katalog (resep / BOM opsional).
6. Lakukan transaksi pertama (tunai atau QRIS).
7. Tutup hari (end-of-day) dengan rekonsiliasi kas.

Setiap langkah punya **deep link** ke layar yang relevan — kalau sedang membaca panduan di tablet (`/help`), Anda bisa langsung loncat dengan satu ketukan.

---

## 0. Yang dibutuhkan sebelum mulai

- **Tablet Android** (Chrome 100+) atau iPad (Safari 16+) yang terhubung ke WiFi atau 4G saat onboarding.
- **Printer Bluetooth ESC/POS** 58 mm atau 80 mm. Lihat daftar yang kami dukung di halaman 7.
- **Email pemilik** (akan jadi login utama Back Office).
- **Saldo QRIS dinamis** (opsional, untuk uji coba pembayaran QRIS — bisa dilewati di hari pertama).

---

## 1. Buat akun pemilik

1. Buka `https://app.kassa.id` di browser desktop.
2. Klik **Daftar warung baru**.
3. Isi: nama warung, email pemilik, kata sandi (minimal 12 karakter), zona waktu (default `Asia/Jakarta`).
4. Verifikasi email lewat link yang masuk ke kotak masuk Anda.
5. Setelah verifikasi, Anda akan diarahkan ke layar **Outlet**.

> **Catatan keamanan:** kata sandi disimpan dengan Argon2id di server. PIN kasir 4–6 digit ditambahkan terpisah saat membuat staf — itu untuk lock-screen tablet, bukan pengganti kata sandi.

---

## 2. Tambah outlet pertama

1. Di Back Office, buka **Outlet** → **Tambah outlet**.
2. Isi:
   - **Kode** (≤ 8 huruf, contoh: `JOG-01`). Akan tercetak di struk.
   - **Nama** (contoh: `Kopi Tugu — Malioboro`).
   - **Zona waktu** (default ikut merchant).
3. Simpan. Outlet langsung aktif — Anda bisa enrol tablet kasir ke sini.

> **Tip:** kode outlet sebaiknya pendek dan konsisten — `JOG-01`, `JOG-02`, `SOL-01` lebih mudah dibaca di laporan EOD daripada nama panjang.

---

## 3. Enrol tablet kasir

Tablet kasir terhubung ke outlet lewat **kode enrolment 8 karakter** yang berlaku 15 menit dan hanya bisa dipakai sekali.

1. Di Back Office, buka **Perangkat** → pilih outlet → **Buat kode enrolment**.
2. Layar menampilkan kode (contoh: `ABCD2345`) dan QR.
3. Di tablet kasir, buka `https://pos.kassa.id` → tablet otomatis ke layar **Enrol perangkat** (`/enrol`).
4. **Dua opsi:**
   - Ketuk **Pindai QR** dan arahkan kamera ke layar Back Office, **atau**
   - Ketik kode 8 karakter manual (huruf besar; tidak ada `O`, `I`, `L`, `U`).
5. Ketuk **Hubungkan perangkat**. Kalau berhasil, tablet otomatis ke `/catalog` dan menunjukkan toast _"Perangkat terhubung ke {outlet}"_.

> **Kalau gagal:** kode kedaluwarsa (15 menit) atau sudah dipakai. Buat kode baru di Back Office. Kode hanya jalan kalau tablet bisa menjangkau API server — pastikan WiFi/4G aktif saat enrol.

**Deep link (di `/help`):** [`/enrol`](/enrol)

---

## 4. Sambungkan printer Bluetooth

1. Pasangkan dulu printer ke tablet di **Pengaturan Bluetooth Android/iOS** (mode pairing tergantung printer — biasanya tahan tombol `Feed` 3 detik).
2. Di tablet, buka `/admin` → **Struk** → pilih lebar kertas (`58mm` atau `80mm` — sesuaikan dengan printer Anda).
3. Lakukan transaksi tes (lihat langkah 6) — saat layar struk muncul, ketuk **Cetak**. Tablet akan memunculkan dialog Web Bluetooth; pilih nama printer Anda.
4. Tablet menyimpan pilihan printer; transaksi berikutnya tidak perlu memilih ulang.

> **Web Bluetooth perlu HTTPS dan Chrome** (bukan WebView in-app). Jika dialog tidak muncul, pastikan Anda membuka `pos.kassa.id` di Chrome langsung, bukan dari shortcut WebView.

**Deep link (di `/help`):** [`/admin`](/admin)

---

## 5. Tambah item katalog pertama

1. Di Back Office, buka **Katalog** → **Tambah item**.
2. Isi:
   - **Kode** (`KOPI-001`, dst.) — unik per merchant.
   - **Nama** (`Espresso`).
   - **Harga** (rupiah, integer — `15000` artinya Rp 15.000).
   - **Satuan** (`pcs` untuk item siap jual; `gram`/`ml` untuk bahan baku).
3. Simpan. Item akan otomatis muncul di tablet kasir setelah sinkronisasi berikutnya (≤ 30 detik kalau online).

### (Opsional) Tambah BOM (resep)

Kalau item Anda dibuat dari bahan baku — misal _Cappuccino = 18 g kopi + 150 ml susu + 8 g gula_ — buat **BOM** supaya stok bahan baku ikut berkurang otomatis tiap transaksi:

1. Tambah dulu bahan-bahan baku sebagai item terpisah (`KOPI-BIJI`, `SUSU-FRESH`, `GULA-PASIR`) dengan satuan `gram`/`ml`. Centang **Tracking stok** dan **Izinkan negatif** kalau stok dikelola di luar sistem.
2. Buka **Katalog** → **BOM** → **Tambah BOM** → pilih item jadi (`Cappuccino`).
3. Tambah komponen: `KOPI-BIJI` 18 gram, `SUSU-FRESH` 150 ml, `GULA-PASIR` 8 gram.
4. Simpan. Tiap kali Cappuccino terjual, ledger stok otomatis mencatat pengurangan untuk tiap komponen di outlet yang bersangkutan.

> **Penting:** BOM hanya berlaku untuk item dengan `bom_id`. Item polos (mis. _Air Mineral_) tidak butuh BOM — penjualannya langsung mengurangi stok item itu sendiri.

---

## 6. Transaksi pertama (tunai)

1. Di tablet kasir, di layar `/catalog`, ketuk item — masuk ke keranjang otomatis.
2. Tambah item lain kalau perlu. Ketuk **Keranjang** untuk review.
3. Ketuk **Bayar tunai** → masukkan jumlah uang yang diterima → tablet menghitung kembalian.
4. Ketuk **Selesai**. Layar **Struk** muncul:
   - Ketuk **Cetak** untuk cetak via Bluetooth.
   - Atau ketuk **Selesai** untuk lompat ke transaksi berikutnya tanpa cetak.

**Catatan offline:** kalau internet sedang putus, transaksi tetap selesai dan masuk ke **outbox** lokal. Indikator `Offline — tersimpan lokal` muncul di kanan atas. Saat koneksi pulih, indikator berganti `Sinkronisasi · {n}` lalu hijau `Online`.

**Untuk QRIS:** ketuk **Bayar QRIS** alih-alih tunai. Saat online, tablet menampilkan QR dinamis dari Midtrans dan menunggu webhook `settlement` (≤ 30 detik). Saat offline, fallback ke QRIS statis (Anda input kode buyer-ref 4 digit dari struk QRIS pemilik).

**Deep link (di `/help`):** [`/catalog`](/catalog)

---

## 7. Tutup hari (end-of-day)

Di akhir hari, kasir membuka `/eod`:

1. Layar menampilkan total tunai dan total QRIS yang **diharapkan** (dihitung dari semua transaksi hari itu).
2. Kasir hitung uang fisik di laci dan masukkan ke kolom **Tunai dihitung**.
3. Sistem menampilkan **selisih** (`varians`):
   - **0** = sempurna; ketuk **Tutup hari**.
   - **≠ 0** = isi alasan singkat (mis. _"kembalian salah Rp 5.000"_) sebelum menutup.
4. Setelah ditutup, hari berikutnya tidak bisa membuka transaksi baru sampai _open day_ ditekan keesokan harinya.

> **Target:** varians **Rp 0** di hari pertama. Kalau ada selisih > Rp 50.000, periksa transaksi yang `dibatalkan` atau `refund` di `/admin` → **Perlu perhatian**.

**Deep link (di `/help`):** [`/eod`](/eod)

---

## 8. Printer yang kami dukung

Daftar resmi v0. Printer di luar daftar ini biasanya tetap bisa cetak via fallback browser-print (CSS), tapi tidak via Bluetooth:

| Vendor   | Model         | Lebar | Service UUID | Catatan                                  |
|:---------|:--------------|:------|:-------------|:-----------------------------------------|
| Xprinter | XP-P323B      | 58 mm | `0x18f0`     | Default. Generic ESC/POS, mudah didapat. |
| Xprinter | XP-P210       | 58 mm | `0x18f0`     | Sama service UUID; kompatibel.            |
| Goojprt  | PT-210, MTP-3 | 58 mm | `0x18f0`     | Sama service UUID; kompatibel.            |
| Bixolon  | SPP-R200III   | 58 mm | _vendor_     | Fallback CSS print (vendor picker M5).   |
| EPSON    | TM-m30        | 80 mm | _vendor_     | Fallback CSS print (vendor picker M5).   |

Sumber kebenaran: `apps/pos/src/features/receipt/bluetooth.ts` (matriks vendor). Kalau Anda menambah vendor baru di kode, perbarui tabel ini di PR yang sama.

---

## 9. Bantuan & troubleshooting cepat

| Gejala                                       | Yang dicek dulu                                                                  |
|:---------------------------------------------|:---------------------------------------------------------------------------------|
| Tablet stuck di `/enrol`                     | Pastikan online; cek kode tidak kedaluwarsa (15 menit); cek server `/health`.    |
| Item baru tidak muncul di tablet             | Tunggu sinkron (≤ 30 detik); ketuk `/admin` → **Segarkan data** untuk paksa refresh. |
| Dialog Bluetooth tidak muncul                | Buka pos.kassa.id di Chrome, bukan WebView; pastikan HTTPS; pastikan permission Bluetooth diaktifkan di settings tablet. |
| QRIS dinamis tidak settle                    | Cek `/admin` → status `Sync gagal`; jika webhook telat > 30 detik, fallback ke QRIS statis. |
| Varians EOD selalu negatif Rp                | Cek `/admin` → **Perlu perhatian** untuk transaksi yang ditolak server.          |

Eskalasi: hubungi support@kassa.id atau WhatsApp +62-… (diisi setelah pilot resmi).

---

## Catatan revisi (revision log)

Catat setiap kali panduan ini direvisi atau diuji ulang dengan tester baru. Acceptance VISION: onboarding < 15 menit, fresh tester, fresh tablet, tanpa bantuan.

| Tgl        | Versi | Tester (peran)                        | Tablet                | Waktu | Hasil   | Catatan                                                              |
|:-----------|:------|:--------------------------------------|:----------------------|:------|:--------|:---------------------------------------------------------------------|
| 2026-04-26 | v0.1  | _belum diuji — child issue dibuat_    | _staging device pilot_ | _-_   | _todo_  | Draft awal landing dengan KASA-69; walkthrough dijadwalkan terpisah. |

Setiap baris baru dalam tabel = satu sesi walkthrough timed. Kalau Anda menambah/menghapus langkah signifikan (mis. memindah PIN setup ke onboarding), bump versi (`v0.2`, dst.) dan jelaskan apa yang berubah di kolom Catatan.

---

## Lampiran: tangkapan layar

Folder `docs/screenshots/onboarding/` menampung tangkapan layar yang dirujuk panduan ini. Tangkapan diambil dari outlet pilot dengan data dari `scripts/seed-pilot.ts`. Lihat child issue yang dibuat oleh KASA-69 untuk daftar tangkapan yang masih harus diambil.
