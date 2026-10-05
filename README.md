# SNAPY Member Checker

Halaman cek member untuk kasir outlet SNAPY Taman Palem & PIK.

- `index.html` — halaman kasir (tidak berisi data member).
- `Code.gs` — script untuk Google Sheet data member (dipasang lewat Extensions > Apps Script).

Data member disimpan di Google Sheet milik pemilik (private). Halaman hanya bisa mencari
satu nomor HP per pencarian, dan harus memakai PIN kasir.

**Jangan pernah upload file Excel/CSV data member ke repository ini.**
