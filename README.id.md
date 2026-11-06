# Gahar Code

Gahar Code adalah CLI coding agentik untuk terminal, ditenagai [OpenRouter](https://openrouter.ai).
Ia membaca proyek, mengubah berkas, menjalankan perintah, lalu menjelaskan apa yang dilakukan,
dengan konfirmasi izin sebelum aksi berisiko. Model apa pun di OpenRouter bisa dipakai.

[English](README.md)

## Pemasangan

Butuh Node.js 20 atau lebih baru.

```sh
npm install -g https://github.com/mhanafi09051998/gahar-code/releases/latest/download/gahar-code.tgz
```

Setiap rilis di [halaman Releases](https://github.com/mhanafi09051998/gahar-code/releases) memuat
`gahar-code.tgz` dan `gahar-code.tgz.sha256`. Cek versi dengan `gahar --version`.

## Mulai cepat

```sh
gahar auth login          # simpan API key OpenRouter
gahar setup               # atur API key dan model bawaan
gahar                     # sesi interaktif di direktori saat ini
gahar -p "ringkas repo ini"   # satu prompt, cetak jawaban, keluar
```

API key dibuat di <https://openrouter.ai/keys>. Bisa juga memakai variabel `OPENROUTER_API_KEY`.

## Pembaruan

```sh
gahar update --check   # tampilkan versi terpasang dan versi terbaru
gahar update           # unduh, verifikasi checksum, pasang rilis terbaru
gahar update --force   # pasang ulang rilis terbaru walau sudah terbaru
```

`gahar update` mengunduh `gahar-code.tgz` dari rilis GitHub terbaru, mencocokkan sha256 dengan
`gahar-code.tgz.sha256`, menjalankan `npm install -g --force`, lalu memastikan hasilnya lewat
`gahar --version`. Bila gagal, perintah manual di bagian Pemasangan ditampilkan.

Saat mulai, Gahar Code mengecek API rilis GitHub paling sering sekali per 24 jam (batas waktu
3 detik) dan menampilkan satu baris bila ada versi baru. Matikan dengan `--no-update-check` atau
`GAHAR_NO_UPDATE_CHECK=1`. Aktifkan Watch > Custom > Releases di GitHub agar mendapat notifikasi.

## Mode izin

| Mode | Baca | Ubah berkas di proyek | Perintah shell dan jaringan | Di luar proyek |
| --- | --- | --- | --- | --- |
| `ask` (bawaan) | boleh | tanya | tanya | tanya |
| `auto-edit` | boleh | boleh | tanya | tanya |
| `full-auto` | boleh | boleh | boleh | tanya |

Pilih lewat `--permission-mode`, `--yolo` (sama dengan `full-auto`), `/permissions`, atau
`GAHAR_PERMISSION_MODE`. `/undo` memulihkan berkas yang diubah giliran sebelumnya.

## Opsi dan perintah

Opsi: `-p, --print <teks>`, `-m, --model <id>`, `--permission-mode <mode>`, `--yolo`,
`--max-tokens <n>`, `--json`, `-c, --continue`, `-r, --resume <id>`, `--no-update-check`,
`--no-color`, `--debug`, `-q, --quiet`, `-v, --version`, `-h, --help`.

Perintah: `setup`, `auth login|status|logout`, `model list|set <id>|show`,
`sessions list|show <id>|rm <id>`, `doctor`, `update [--check] [--force]`, `help`.

Perintah slash di sesi interaktif: `/help`, `/model [id]`, `/auth`, `/init`, `/compact`, `/clear`,
`/undo`, `/cost`, `/status`, `/permissions [mode]`, `/verbose`, `/exit`, `/quit`.
Penjelasan lengkap tiap opsi ada di [README.md](README.md#command-line).

## Konfigurasi

| Lokasi | Isi |
| --- | --- |
| `~/.gahar/config.json` | pengaturan global dan API key dari `gahar auth login` |
| `<proyek>/.gahar/config.json` | pengaturan per proyek (rahasia diabaikan di sini) |
| `~/.gahar/projects/` | sesi tersimpan per proyek |
| `AGENTS.md` atau `GAHAR.md` | instruksi proyek untuk model |

Variabel lingkungan: `OPENROUTER_API_KEY`, `GAHAR_MODEL`, `GAHAR_BASE_URL`,
`GAHAR_PERMISSION_MODE`, `GAHAR_CONFIG_DIR`, `GAHAR_NO_UPDATE_CHECK`, `GAHAR_DEBUG`, `GAHAR_JSON`,
`GAHAR_NO_COLOR`, `GAHAR_SHELL`. Contoh ada di [.env.example](.env.example). Urutan prioritas:
opsi baris perintah, variabel lingkungan, konfigurasi proyek, konfigurasi global, nilai bawaan.

## Pemecahan masalah

| Gejala | Solusi |
| --- | --- |
| `401` dari OpenRouter | key salah atau dicabut: `gahar auth login` |
| `402` kredit tidak cukup | isi kredit di <https://openrouter.ai/settings/credits> |
| `404` model tidak ditemukan | `gahar model list`, lalu `gahar model set <id>` |
| `429` batas laju | tunggu sebentar atau ganti model |
| `gahar` tidak ditemukan | buka terminal baru; pastikan `npm prefix -g` ada di `PATH` |
| `gahar update` gagal EACCES | perbaiki izin global npm atau pakai pengelola versi Node |
| lainnya | `gahar doctor`, lalu `gahar --debug` |

## Lisensi

[MIT](LICENSE)
