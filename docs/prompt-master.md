```
---
## Sumber Resmi
### LIGHTER
- https://docs.lighter.xyz/
- https://apidocs.lighter.xyz/docs/
- https://apidocs.lighter.xyz/reference/
- Python SDK: https://github.com/elliottech/lighter-python
- Go SDK: https://github.com/elliottech/lighter-go

---
## Scope Audit

### Backend — `artifacts/api-server/src/`
- `app.ts`, `index.ts`
- `middlewares/auth.ts`
- `routes/` — semua file termasuk sub-folder lighter
- `lib/lighter/` — lighterApi, lighterBotEngine, lighterSigner, lighterWs, marketCache
- `lib/` — autoRerange, groqAI, smartBroadcaster, telegramBot, logger, utils, encrypt, sessionStore, neonBroadcastDb
- `lib/shared/tolerance.ts`

### Database — `lib/db/src/schema/`
- botConfig, botLogs, strategies, trades, users, pendingPayments

### Frontend — `artifacts/HK-Projects/src/`
- `pages/`, `components/lighter`, `components/strategies`, `hooks/`, `context/`

---
## Aturan Kerja

- Baca file asli terlebih dahulu sebelum membuat kesimpulan apapun. Jangan asumsikan behavior kode tanpa membaca.
- Fetch sumber resmi DEX yang relevan sebelum menilai implementasi.
- Setiap sesi: lapor maksimal 5 issue teratas by priority. Catat sisa temuan untuk sesi berikutnya.
- Satu issue = satu propose = satu approval. Jangan bundling.
- Jika menemukan issue tambahan saat membaca file, catat — jangan fix tanpa lapor dulu.
- Di akhir sesi, output carry-over list untuk sesi berikutnya.

## Severity

- **Critical** — bot bisa loss / crash / data korup di mainnet
- **High** — data salah, logic mismatch vs dokumentasi resmi
- **Medium** — inefficiency, edge case tidak di-handle
- **Low** — dead code, code smell, naming inconsistency

## Alur Per Issue

### Step — Propose
Laporan singkat:
- **File:** path lengkap
- **Severity:** Critical / High / Medium / Low
- **Masalah:** apa yang salah dan mengapa
- **Sebelum:** potongan kode bermasalah
- **Sesudah:** potongan kode yang diusulkan
- **Risiko fix:** ada side effect?

### Step — Eksekusi
Tunggu approval sebelum menyentuh kode apapun.

## Output Log
- Reasoning dalam Bahasa Indonesia
- Code dan field names tetap English
- Simpan hasil audit ke `docs/audit/audit-{nama-audit}.md`
- Referensi dokumentasi DEX di `docs/{nama-dex}-docs/`

---
## Mulai
Cek carry-over dari sesi sebelumnya di `docs/audit/`.
Jika tidak ada, mulai dari scope Backend → Database → Frontend.
Propose issue pertama (Critical/High priority) setelah konfirmasi kode bermasalah ditemukan.
```