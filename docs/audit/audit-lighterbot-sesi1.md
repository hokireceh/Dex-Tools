# Audit LighterBot — Sesi 1

**Tanggal:** 2026-05-03
**Auditor:** Replit Agent
**Scope:** `lighterBotEngine.ts`, `lighterFrArbEngine.ts`, `lighterApi.ts`, `lighterWs.ts`, `lighterSigner.ts`, `autoRerange.ts`, `budgetTracker.ts`, `marketCache.ts`, `configService.ts`, `shared/botLogic.ts`, `shared/tolerance.ts`, `utils.ts`, `lib/db/src/schema/`
**Mode:** Fix-all — semua issue langsung di-fix, `tsc --noEmit` harus bersih setelah setiap perubahan.

---

## Ringkasan Temuan

| # | File | Severity | Judul | Status |
|---|------|----------|-------|--------|
| 1 | `lighterFrArbEngine.ts` | **High** | `getNextNonce` langsung bypass `acquireNonce` chain — nonce collision jika grid + FR Arb aktif bersamaan | ✅ Fixed |
| 2 | `lighterFrArbEngine.ts` | **Medium** | `clientOrderIndex` pakai `Date.now() %` bukan `nextClientOrderIndex()` — potensi duplikat lintas engine | ✅ Fixed |
| 3 | `lighterBotEngine.ts` | **Medium** | `updateStrategyStatsAtomic` — `realized_pnl` pada SELL path salah untuk mode SHORT | ✅ Fixed |
| 4 | `autoRerange.ts` | **Medium** | `applyApprovedRerangeParams` tidak reset `budgetSpentUsd` saat rerange disetujui | ✅ Fixed |
| 5 | `lighterFrArbEngine.ts` | **Medium** | `pollLighterPendingEntry` — `estimatedFillPrice` selalu pakai mid-price, bukan harga fill aktual dari `event_info` | ✅ Fixed |

**`tsc --noEmit` final: BERSIH (0 error)**

---

## Issue #1 — HIGH: Nonce Collision antara FR Arb Engine dan Grid Engine

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` (baris 344–351)
**Fix ID:** `AUDIT-NONCE-001`

### Masalah

`placeLighterFrOrder` memanggil `getNextNonce` langsung dari Lighter API, **melewati** `acquireNonce` chain (BUG-L-003 yang sudah di-fix di lighterBotEngine). Jika user menjalankan:

1. Grid bot — menggunakan `acquireNonce` → in-memory chain per `network:accountIndex:apiKeyIndex`
2. FR Arb bot — menggunakan `getNextNonce` langsung → fetch baru dari API, tidak membaca cache chain

Keduanya berbagi **nonce space yang sama** di Lighter. `getNextNonce` dari FR Arb tidak membaca cache `_nonceChain` milik grid engine, sehingga bisa terjadi: grid engine mengambil nonce N dari cache, FR Arb mengambil nonce N dari API (sebelum grid engine `sendTx`), keduanya submit dengan nonce N → sequencer reject satu order.

Lighter docs (`signing-transactions.md`): `new_nonce` harus `old_nonce + 1` — sequencer reject jika nonce sudah pernah digunakan.

### Sebelum

```ts
// lighterFrArbEngine.ts
let nonce: number;
try {
  nonce = await getNextNonce(accountIndex, apiKeyIndex, network);  // bypass chain!
} catch (err) { ... }
```

### Fix

Dibuat file baru `artifacts/api-server/src/lib/lighter/nonceManager.ts` yang mengekstrak semua state dan fungsi nonce dari `lighterBotEngine.ts`:

- `nextClientOrderIndex()` — atomic counter
- `acquireNonce()` — per-key serial chain
- `invalidateNonceCache()` — hapus cache tanpa putus chain
- `shouldInvalidateNonce()` — heuristik error
- `enqueueOrphanCancel()` — serial orphan cancel chain
- `waitForOrphanCancels()` — baca chain saat ini tanpa modifikasi

`lighterBotEngine.ts` dan `lighterFrArbEngine.ts` keduanya import dari `nonceManager.ts` sehingga satu module-level state yang sama digunakan oleh semua engine.

```ts
// lighterFrArbEngine.ts — sesudah
import { acquireNonce, invalidateNonceCache, shouldInvalidateNonce, nextClientOrderIndex } from "./nonceManager";

let nonce: number;
try {
  nonce = await acquireNonce(accountIndex, apiKeyIndex, network);  // serial chain terpadu
} catch (err) { ... }
```

```ts
// lighterBotEngine.ts — sesudah
import { nextClientOrderIndex, acquireNonce, invalidateNonceCache,
         shouldInvalidateNonce, enqueueOrphanCancel, waitForOrphanCancels } from "./nonceManager";
// Semua definisi lokal (lines 54–161) dihapus.
```

**File baru:** `artifacts/api-server/src/lib/lighter/nonceManager.ts`

---

## Issue #2 — MEDIUM: `clientOrderIndex` Tidak Atomic di FR Arb Engine

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` (baris 364)
**Fix ID:** `AUDIT-COI-001`

### Masalah

`placeLighterFrOrder` menggunakan `Date.now() % 281_474_976_710_655` untuk `clientOrderIndex`. Persis masalah yang sama yang sudah di-fix di `lighterBotEngine.ts` (komentar lines 54–65). Jika dua FR Arb tick untuk strategi berbeda terjadi dalam millisecond yang sama, mereka menghasilkan `clientOrderIndex` identik → satu order ditolak exchange karena duplicate client order index.

### Sebelum

```ts
const clientOrderIndex = Date.now() % 281_474_976_710_655;
```

### Sesudah

```ts
// Atomic counter bersama dari nonceManager — tidak ada potensi duplikat
const clientOrderIndex = nextClientOrderIndex();
```

Counter `_clientOrderCounter` di `nonceManager.ts` adalah module-level singleton — satu instance untuk seluruh proses, shared oleh `lighterBotEngine` dan `lighterFrArbEngine`.

---

## Issue #3 — MEDIUM: `realized_pnl` SELL Path Salah untuk Mode SHORT

**File:** `artifacts/api-server/src/lib/lighter/lighterBotEngine.ts` — `updateStrategyStatsAtomic`
**Fix ID:** `AUDIT-PNL-001`

### Masalah

Pada `updateStrategyStatsAtomic`, SELL path SQL:

```sql
realized_pnl + CASE
  WHEN avg_buy_price > 0
  THEN (size * (price - avg_buy_price))
  ELSE 0
END
```

Untuk **mode SHORT**: SELL = *membuka* posisi short (bukan menutup long). PnL tidak direalisasikan saat membuka posisi. Namun `avg_buy_price > 0` bisa true (dari BUY orders yang menutup short), sehingga formula ini menambahkan `size * (price - avg_buy_price)` ke `realized_pnl` untuk setiap SELL di mode SHORT → **double-counted**.

Semantik yang benar:
- `neutral`/`long` grid: SELL = menutup long → realize PnL `size * (price - avg_buy_price)` ✓
- `short` grid: SELL = membuka short → **tidak** realize PnL. PnL short direalisasikan saat BUY (tutup short) via `avg_sell_price` formula di BUY path.

### Sebelum

```sql
WHEN avg_buy_price > 0
THEN (size * (price - avg_buy_price))
```

### Sesudah

```sql
WHEN ${mode} != 'short' AND avg_buy_price > 0
THEN (size * (price - avg_buy_price))
```

**Catatan:** Bot yang sudah berjalan di mode SHORT memiliki `realized_pnl` yang over-stated. Tidak ada auto-koreksi retrospektif — perlu recalculate manual jika akurasi historis diperlukan.

---

## Issue #4 — MEDIUM: `budgetSpentUsd` Tidak Di-reset Setelah Rerange

**File:** `artifacts/api-server/src/lib/autoRerange.ts` — `applyApprovedRerangeParams`
**Fix ID:** `AUDIT-BUDGET-001`

### Masalah

Saat user menyetujui auto-rerange, `applyApprovedRerangeParams` memperbarui config grid baru tapi tidak mereset `budgetSpentUsd`. Jika bot mendekati `maxBudgetUsd` sebelum rerange, setelah rerange disetujui, bot akan langsung berhenti karena counter masih menunjukkan nilai lama — padahal rerange = sesi grid baru dengan range berbeda.

### Sebelum

```ts
await db.update(strategiesTable).set({
  gridConfig: newGridConfig,
  consecutiveOutOfRange: 0,
  pendingRerangeAt: null,
  // ... (tidak ada budgetSpentUsd reset)
  gridLastLevel: null,
  updatedAt: new Date(),
}).where(eq(strategiesTable.id, strategyId));
```

### Sesudah

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
  budgetSpentUsd: "0",   // ← AUDIT-BUDGET-001: reset untuk sesi grid baru
  updatedAt: new Date(),
}).where(eq(strategiesTable.id, strategyId));
```

---

## Issue #5 — MEDIUM: `estimatedFillPrice` Pakai Mid-Price, Bukan Harga Fill Aktual

**File:** `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` — `pollLighterPendingEntry`
**Fix ID:** `AUDIT-FILL-001`

### Masalah

`pollLighterPendingEntry` mengembalikan `estimatedFillPrice: fallbackPrice` (mid-price saat polling) untuk semua status filled. Lighter API menyertakan `event_info` di response `getTx` — sebuah JSON string yang berisi data eksekusi order (termasuk harga fill aktual). Field ini tidak pernah diekstrak, sehingga `entryPrice` yang tersimpan di `frArbState` selalu mid-price saat poll, bukan harga fill sebenarnya.

Dampak: PnL yang ditampilkan ke user via Telegram tidak akurat, terutama untuk market order atau limit order dengan spread lebar.

### Sebelum

```ts
if (txStatus === 2 || txStatus === 3) {
  return { status: "filled", estimatedFillPrice: fallbackPrice };
}
```

### Sesudah

Ditambahkan fungsi `parseFillPriceFromEventInfo()` yang:
1. Parse `event_info` sebagai JSON
2. Coba field `avgPrice`, `avg_price`, `price`, `fill_price` (defensif terhadap perubahan format API)
3. Validasi nilai (isFinite, > 0)
4. Fallback ke `fallbackPrice` jika parsing gagal

```ts
function parseFillPriceFromEventInfo(eventInfo: string | undefined, fallback: number): number {
  if (!eventInfo) return fallback;
  try {
    const parsed = JSON.parse(eventInfo) as Record<string, unknown>;
    const raw =
      parsed["avgPrice"] ?? parsed["avg_price"] ??
      parsed["price"] ?? parsed["fill_price"];
    if (raw === undefined || raw === null) return fallback;
    const val = Number(raw);
    return isFinite(val) && val > 0 ? val : fallback;
  } catch {
    return fallback;
  }
}

if (txStatus === 2 || txStatus === 3) {
  const fillPrice = parseFillPriceFromEventInfo(txResp.event_info, fallbackPrice);
  return { status: "filled", estimatedFillPrice: fillPrice };
}
```

**Catatan:** Format `event_info` aktual dari Lighter API belum ter-dokumentasi secara eksplisit. Implementasi defensif dengan multiple key lookup dan hard fallback. Perlu verifikasi terhadap response nyata dari mainnet untuk konfirmasi field yang tepat.

---

## Bonus Fix — `invalidateNonceCache` saat `sendTx` Gagal di FR Arb

Ditemukan saat mengerjakan Issue #1: `lighterFrArbEngine.ts` tidak memanggil `invalidateNonceCache` saat `sendTx` gagal, padahal `lighterBotEngine.ts` melakukannya. Nonce yang sudah di-acquire tapi gagal terkirim dapat menyebabkan nonce gap — sequencer reject order berikutnya.

**Fix:** Tambahkan `shouldInvalidateNonce` + `invalidateNonceCache` di catch block `sendTx`:

```ts
} catch (err) {
  if (shouldInvalidateNonce(err)) {
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
  }
  await frLog(...);
  return null;
}
```

---

## File yang Dimodifikasi

| File | Perubahan |
|------|-----------|
| `artifacts/api-server/src/lib/lighter/nonceManager.ts` | **BARU** — shared nonce + clientOrderIndex manager |
| `artifacts/api-server/src/lib/lighter/lighterBotEngine.ts` | Hapus definisi lokal nonce (lines 54–161), import dari `nonceManager`, ganti `_orphanCancelChain.get()` dengan `waitForOrphanCancels()` |
| `artifacts/api-server/src/lib/lighter/lighterFrArbEngine.ts` | Hapus `getNextNonce` dari import, import dari `nonceManager`, fix `acquireNonce`/`nextClientOrderIndex`, add `invalidateNonceCache` di sendTx catch, fix `pollLighterPendingEntry` |
| `artifacts/api-server/src/lib/autoRerange.ts` | Tambah `budgetSpentUsd: "0"` di `applyApprovedRerangeParams` |
| `artifacts/api-server/src/lib/lighter/lighterBotEngine.ts` | Fix `realized_pnl` SELL SQL — tambah `${mode} != 'short' AND` |

---

## Carry-over untuk Sesi Berikutnya

File yang **belum** diperiksa mendalam:

- `artifacts/api-server/src/lib/extended/extendedBotEngine.ts` (full)
- `artifacts/api-server/src/lib/frArbEngine.ts` — Extended FR Arb engine
- `artifacts/api-server/src/lib/autoRerange.ts` (sisa baris 360–843)
- `artifacts/api-server/src/lib/groqAI.ts`
- `artifacts/api-server/src/lib/telegramBot.ts`
- `artifacts/api-server/src/routes/` (semua file)
- `artifacts/HK-Projects/src/` (frontend — pages, components)
- `lib/db/src/schema/users.ts`, `botConfig.ts`, `botLogs.ts`

**Priority untuk sesi berikutnya:** Extended engine (`extendedBotEngine.ts`) dan route handlers — biasanya ada input validation issues.
