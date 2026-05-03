# Audit LighterBot — Sesi 1

**Tanggal:** 2026-05-03
**Auditor:** Replit Agent
**Scope:** `lighterBotEngine.ts`, `lighterFrArbEngine.ts`, `lighterApi.ts`, `lighterWs.ts`, `lighterSigner.ts`, `autoRerange.ts`, `budgetTracker.ts`, `marketCache.ts`, `configService.ts`, `shared/botLogic.ts`, `shared/tolerance.ts`, `utils.ts`, `lib/db/src/schema/`

---

## Ringkasan Temuan

| # | File | Severity | Judul | Status |
|---|------|----------|-------|--------|
| 1 | `lighterFrArbEngine.ts` | **High** | `getNextNonce` langsung tanpa `acquireNonce` chain — nonce collision jika grid + FR Arb aktif bersamaan | 🔲 Pending |
| 2 | `lighterFrArbEngine.ts` | **Medium** | `clientOrderIndex` pakai `Date.now() %` bukan `nextClientOrderIndex()` — potensi duplikat | 🔲 Pending |
| 3 | `lighterBotEngine.ts` | **Medium** | `updateStrategyStatsAtomic` — `realized_pnl` pada SELL path salah untuk mode SHORT | 🔲 Pending |
| 4 | `autoRerange.ts` | **Medium** | `applyApprovedRerangeParams` tidak reset `budgetSpentUsd` saat rerange disetujui | 🔲 Pending |
| 5 | `lighterFrArbEngine.ts` | **Medium** | `pollLighterPendingEntry` — `estimatedFillPrice` pakai mid-price (fallback), bukan harga fill aktual | 🔲 Pending |

---

## Issue #1 — HIGH: Nonce Collision antara FR Arb Engine dan Grid Engine

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` (baris 344–351)

**Masalah:**
`placeLighterFrOrder` memanggil `getNextNonce` langsung dari Lighter API, **melewati** `acquireNonce` chain yang ada di `lighterBotEngine.ts` (BUG-L-003). Jika seorang user menjalankan:
1. Grid bot (menggunakan `acquireNonce` → in-memory chain per `accountIndex:apiKeyIndex`)
2. FR Arb bot (menggunakan `getNextNonce` langsung → fetch baru dari API)

...keduanya berbagi **nonce space yang sama** di Lighter (per `accountIndex + apiKeyIndex`). Karena `getNextNonce` dari FR Arb tidak membaca cache `_nonceChain` milik grid engine, dapat terjadi collision: grid engine mengambil nonce N dari cache, FR Arb mengambil nonce N dari API (sebelum grid engine melakukan `sendTx`), keduanya submit dengan nonce N → sequencer reject satu.

Lighter docs (`signing-transactions.md`): `new_nonce` harus `old_nonce + 1` — sequencer reject jika nonce sudah pernah digunakan.

**Sebelum:**
```ts
// lighterFrArbEngine.ts line 342–351
let nonce: number;
try {
  nonce = await getNextNonce(accountIndex, apiKeyIndex, network);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await frLog(..., "[LighterFrArb] Gagal acquire nonce", msg);
  return null;
}
```

**Sesudah (usulan):**
Impor `acquireNonce` dan `invalidateNonceCache` dari `lighterBotEngine.ts` (atau ekstrak ke shared module), lalu ganti `getNextNonce` dengan `acquireNonce`:
```ts
// lighterFrArbEngine.ts line 342–351
let nonce: number;
try {
  nonce = await acquireNonce(accountIndex, apiKeyIndex, network);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await frLog(..., "[LighterFrArb] Gagal acquire nonce", msg);
  return null;
}
```
`acquireNonce` chain + `_nonceValue` cache harus di-shared (pindahkan ke `lighterSigner.ts` atau `nonceManager.ts` baru) agar `lighterFrArbEngine.ts` bisa mengimportnya tanpa circular dependency.

**Risiko fix:** Perlu refactor `acquireNonce` + `invalidateNonceCache` + `_nonceChain`/`_nonceValue`/`_nonceVersion` keluar dari `lighterBotEngine.ts` ke file shared. Tidak ada behavioral change untuk grid bot — hanya FR Arb yang berubah cara acquire nonce.

---

## Issue #2 — MEDIUM: `clientOrderIndex` Tidak Atomic di FR Arb Engine

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` (baris 364)

**Masalah:**
`placeLighterFrOrder` menggunakan `Date.now() % 281_474_976_710_655` untuk `clientOrderIndex`. Ini identik dengan masalah yang sudah di-fix di `lighterBotEngine.ts` (komentar baris 54–65: "never use Date.now() directly to avoid same-millisecond duplicates"). Jika dua FR Arb tick untuk strategi berbeda pada account yang sama terjadi dalam millisecond yang sama, mereka bisa menghasilkan `clientOrderIndex` identik → satu order ditolak exchange.

**Sebelum:**
```ts
// lighterFrArbEngine.ts line 364
const clientOrderIndex = Date.now() % 281_474_976_710_655;
```

**Sesudah:**
```ts
// Impor nextClientOrderIndex dari lighterBotEngine (setelah refactor ke shared)
const clientOrderIndex = nextClientOrderIndex();
```

**Risiko fix:** Bergantung pada refactor Issue #1 (jika `nextClientOrderIndex` ikut dipindahkan ke shared module).

---

## Issue #3 — MEDIUM: `realized_pnl` SELL Path Salah untuk Mode SHORT

**File:** `artifacts/api-server/src/lib/lighter/lighterBotEngine.ts` (baris 409–428)

**Masalah:**
Pada `updateStrategyStatsAtomic`, SELL path selalu menghitung:
```sql
realized_pnl + CASE WHEN avg_buy_price > 0
  THEN (size * (price - avg_buy_price))
  ELSE 0
END
```
Untuk mode SHORT: SELL order = **membuka** short (bukan menutup long). PnL untuk membuka posisi baru tidak boleh di-realize di saat order ditempatkan. Namun karena `avg_buy_price > 0` bisa bernilai true (dari BUY orders sebelumnya di mode SHORT yang close short), formula ini salah menambahkan `size * (price - avg_buy_price)` ke `realized_pnl` untuk setiap SELL di mode SHORT. Akibatnya: realized_pnl double-counted untuk SHORT grid bot.

**Sesudah (usulan):**
Tambahkan kondisi mode:
```sql
realized_pnl + CASE
  WHEN ${mode} != 'short' AND avg_buy_price > 0
  THEN (size * (price - avg_buy_price))
  ELSE 0
END
```

**Risiko fix:** Hanya mempengaruhi tampilan stats (bukan logika trading). Bot yang sudah jalan tidak terpengaruh karena `realized_pnl` lama tidak di-recalculate. Akumulasi PnL salah pada SHORT bot yang sudah berjalan tidak otomatis terkoreksi.

---

## Issue #4 — MEDIUM: `budgetSpentUsd` Tidak Di-reset Setelah Rerange

**File:** `artifacts/api-server/src/lib/autoRerange.ts` (baris 335–348)

**Masalah:**
Saat user menyetujui auto-rerange (`applyApprovedRerangeParams`), DB di-update dengan config grid baru. Namun `budgetSpentUsd` di tabel `strategies` **tidak di-reset ke 0**. Akibatnya: jika bot mendekati `maxBudgetUsd` sebelum rerange, setelah rerange disetujui, bot mungkin langsung berhenti karena counter masih menunjukkan nilai lama. Ini terutama bermasalah karena rerange = "sesi baru" — user wajar mengharapkan budget counter direset.

**Sebelum:**
```ts
await db.update(strategiesTable).set({
  gridConfig: newGridConfig,
  consecutiveOutOfRange: 0,
  pendingRerangeAt: null,
  pendingRerangeParams: null,
  lastRerangeAt: new Date(),
  rerangeCountToday: currentCount + 1,
  rerangeCountDate: today,
  gridLastLevel: null,
  updatedAt: new Date(),
}).where(eq(strategiesTable.id, strategyId));
```

**Sesudah:**
```ts
await db.update(strategiesTable).set({
  gridConfig: newGridConfig,
  consecutiveOutOfRange: 0,
  pendingRerangeAt: null,
  pendingRerangeParams: null,
  lastRerangeAt: new Date(),
  rerangeCountToday: currentCount + 1,
  rerangeCountDate: today,
  gridLastLevel: null,
  budgetSpentUsd: "0",  // Reset budget counter — rerange = sesi baru
  updatedAt: new Date(),
}).where(eq(strategiesTable.id, strategyId));
```

**Risiko fix:** Minimal. User yang sengaja ingin mempertahankan budget counter lintas rerange akan kehilangan fitur itu, tapi behavior ini tidak terdokumentasi dan counter-intuitive. Reset adalah perilaku yang lebih logis.

---

## Issue #5 — MEDIUM: `estimatedFillPrice` di FR Arb Pakai Mid-Price, Bukan Harga Fill Aktual

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` (baris 425–449)

**Masalah:**
`pollLighterPendingEntry` mengembalikan `estimatedFillPrice: fallbackPrice` (mid-price saat polling) untuk semua status filled (txStatus=2 atau 3). Harga fill aktual mungkin ada di `txResp.event_info` (OrderExecution struct dari Lighter API), tapi tidak diekstrak. Akibatnya: `entryPrice` yang tersimpan di `frArbState` adalah **estimasi** (mid-price saat poll), bukan harga fill sebenarnya. PnL yang ditampilkan ke user via Telegram tidak akurat.

**Sebelum:**
```ts
if (txStatus === 2 || txStatus === 3) {
  return { status: "filled", estimatedFillPrice: fallbackPrice };
}
```

**Sesudah:**
```ts
if (txStatus === 2 || txStatus === 3) {
  // Coba ekstrak fill price dari event_info (OrderExecution.to.px atau .mo.px)
  let fillPrice = fallbackPrice;
  if (txResp.event_info) {
    try {
      const ei = JSON.parse(txResp.event_info) as any;
      const rawPx = ei?.t?.px ?? ei?.to?.px ?? ei?.mo?.px;
      if (rawPx && parseFloat(rawPx) > 0) fillPrice = parseFloat(rawPx);
    } catch {}
  }
  return { status: "filled", estimatedFillPrice: fillPrice };
}
```

**Risiko fix:** Jika `event_info` tidak tersedia atau formatnya berbeda dari yang diasumsikan, fallback ke `fallbackPrice` tetap dipakai — tidak ada regresi. Perlu validasi terhadap struktur `event_info` aktual dari Lighter API sebelum merge.

---

## Carry-over untuk Sesi Berikutnya

File yang belum diperiksa mendalam:
- `artifacts/api-server/src/lib/extended/extendedBotEngine.ts` (full)
- `artifacts/api-server/src/lib/frArbEngine.ts` (sisa baris 100–802)
- `artifacts/api-server/src/lib/autoRerange.ts` (sisa baris 400–843)
- `artifacts/api-server/src/lib/groqAI.ts`
- `artifacts/api-server/src/lib/telegramBot.ts`
- `artifacts/api-server/src/routes/` (semua file)
- `artifacts/HK-Projects/src/` (frontend — pages, components)
- `lib/db/src/schema/users.ts`, `botConfig.ts`, `botLogs.ts`
