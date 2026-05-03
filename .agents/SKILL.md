---
name: lighterbot-audit
description: Panduan kerja audit dan pengembangan LighterBot — trading bot dashboard untuk Lighter.xyz dan Extended Exchange. Baca sebelum memulai sesi apapun di project ini.
---

# LighterBot — Panduan Kerja Agent

## Tentang Project Ini

LighterBot adalah automated trading bot system untuk **Lighter.xyz** dan **Extended Exchange**. Terdiri dari:
- **Backend API**: `artifacts/api-server/` — Express + TypeScript + Drizzle ORM + PostgreSQL
- **Frontend Dashboard**: `artifacts/HK-Projects/` — React 19 + Vite + Tailwind CSS v4 + Shadcn UI
- **Shared Libs**: `lib/` — db schema, api-spec, api-client-react, api-zod
- **Bot Types**: Grid Bot, DCA Bot, Funding Rate Arbitrage (FrArb)
- **Telegram Integration**: user management, payment (Saweria), notifikasi real-time via Telegraf
- **AI Analysis**: Groq SDK untuk analisis pasar

## Sumber Resmi DEX

### Lighter
- Docs: https://docs.lighter.xyz/
- API Docs: https://apidocs.lighter.xyz/docs/
- API Reference: https://apidocs.lighter.xyz/reference/
- Python SDK: https://github.com/elliottech/lighter-python
- Go SDK: https://github.com/elliottech/lighter-go

## Scope File Penting

### Backend — `artifacts/api-server/src/`
- `app.ts`, `index.ts`
- `middlewares/auth.ts`
- `routes/` — semua file termasuk sub-folder lighter & extended
- `lib/lighter/` — lighterApi, lighterBotEngine, lighterSigner, lighterWs, marketCache, lighterFrArbEngine
- `lib/extended/` — extendedBotEngine, extendedWs
- `lib/` — autoRerange, groqAI, smartBroadcaster, telegramBot, logger, utils, encrypt, sessionStore, neonBroadcastDb, frArbEngine, budgetTracker
- `lib/shared/tolerance.ts`

### Database — `lib/db/src/schema/`
- `botConfig.ts`, `botLogs.ts`, `strategies.ts`, `trades.ts`, `users.ts`, `pendingPayments.ts`

### Frontend — `artifacts/HK-Projects/src/`
- `pages/`, `components/lighter/`, `components/strategies/`, `hooks/`, `context/`

## Aturan Kerja

1. **Baca file asli terlebih dahulu** sebelum membuat kesimpulan. Jangan asumsikan behavior kode tanpa membaca.
2. **Fetch sumber resmi DEX** yang relevan sebelum menilai implementasi.
3. **Setiap sesi**: lapor maksimal 5 issue teratas by priority. Catat sisa temuan untuk sesi berikutnya.
4. **Satu issue = satu propose = satu approval.** Jangan bundling beberapa fix sekaligus.
5. Jika menemukan issue tambahan saat membaca file, catat — jangan fix tanpa lapor dulu.
6. Di akhir sesi, output **carry-over list** untuk sesi berikutnya.
7. **Tunggu approval** sebelum menyentuh kode apapun.

## Severity Classification

| Level | Kapan |
|-------|-------|
| **Critical** | Bot bisa loss / crash / data korup di mainnet |
| **High** | Data salah, logic mismatch vs dokumentasi resmi |
| **Medium** | Inefficiency, edge case tidak di-handle |
| **Low** | Dead code, code smell, naming inconsistency |

## Format Propose Issue

```
**File:** path/lengkap/ke/file.ts
**Severity:** Critical / High / Medium / Low
**Masalah:** apa yang salah dan mengapa
**Sebelum:**
\`\`\`ts
// kode bermasalah
\`\`\`
**Sesudah:**
\`\`\`ts
// kode yang diusulkan
\`\`\`
**Risiko fix:** ada side effect?
```

## Output & Logging

- Reasoning ditulis dalam **Bahasa Indonesia**
- Code dan field names tetap **English**
- Simpan hasil audit ke `docs/audit/audit-{nama-audit}.md`
- Referensi dokumentasi DEX di `docs/{nama-dex}-docs/`

## Cara Memulai Sesi

1. Cek carry-over dari sesi sebelumnya di `docs/audit/`
2. Jika tidak ada, mulai dari scope: **Backend → Database → Frontend**
3. Propose issue pertama (Critical/High priority) setelah konfirmasi kode bermasalah ditemukan

## Environment & Stack

- **Runtime**: Node.js 20, pnpm monorepo
- **DB**: PostgreSQL 16 via Drizzle ORM (`DATABASE_URL` sudah di-set oleh Replit)
- **Secrets wajib**: `ADMIN_PASSWORD` (login dashboard)
- **Secrets opsional**: `BOT_TOKEN` (Telegram), `GROQ_API_KEY` (AI analysis), `NEON_DATABASE_URL` (broadcast feature)
- **Ports**: API server `8080`, Frontend `24148`
- **Auth**: Custom session-based (cookie `lb_session` + in-memory store), bukan Replit Auth
