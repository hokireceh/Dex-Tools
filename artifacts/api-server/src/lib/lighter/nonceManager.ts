/**
 * nonceManager.ts — Shared Nonce & ClientOrderIndex Manager
 *
 * Diekstrak dari lighterBotEngine.ts agar lighterFrArbEngine.ts dapat
 * menggunakan chain nonce yang SAMA — mencegah nonce collision antar engine
 * saat user menjalankan grid bot dan FR Arb bot bersamaan pada account yang sama.
 *
 * AUDIT-NONCE-001: lighterFrArbEngine sebelumnya memanggil getNextNonce langsung
 *   (bypass acquireNonce chain) → nonce collision dengan lighterBotEngine jika
 *   grid bot + FR Arb bot aktif bersamaan pada accountIndex + apiKeyIndex yang sama.
 *
 * AUDIT-COI-001: lighterFrArbEngine sebelumnya memakai Date.now() % UINT48_MAX
 *   (bukan atomic counter) → potensi clientOrderIndex duplikat lintas engine.
 */

import { getNextNonce, type Network } from "./lighterApi";

// ─── ATOMIC CLIENT ORDER INDEX COUNTER ──────────────────────────────────────
// uint48 max = 2^48 - 1 = 281,474,976,710,655
// Seed from current time so it survives restarts without collision,
// then increment atomically — never use Date.now() directly to avoid
// same-millisecond duplicates when multiple bots run concurrently.
// AUDIT-COI-001: Single module-level counter shared by ALL engines agar tidak
// ada potensi duplikat clientOrderIndex lintas lighterBotEngine & lighterFrArbEngine.
const UINT48_MAX = BigInt(281_474_976_710_655);
let _clientOrderCounter = BigInt(Date.now() % Number(UINT48_MAX));

export function nextClientOrderIndex(): number {
  _clientOrderCounter = (_clientOrderCounter + 1n) % (UINT48_MAX + 1n);
  return Number(_clientOrderCounter);
}

// ─── PER-KEY NONCE MANAGER (BUG-L-003) ──────────────────────────────────────
// Prevents nonce race conditions when concurrent bots share the same API key.
// Guarantees serial nonce acquisition per (network:accountIndex:apiKeyIndex) key.
// Concurrent calls chain onto each other — only one fetches from API at a time.
//
// AUDIT-NONCE-001: State maps di-share oleh SEMUA engine (lighterBotEngine +
// lighterFrArbEngine). Sebelumnya setiap engine punya chain sendiri → FR Arb bisa
// mendapat nonce yang sama dengan grid bot → sequencer reject satu order.
const _nonceChain = new Map<string, Promise<number>>();
const _nonceValue = new Map<string, number>();
const _nonceVersion = new Map<string, number>();

// ORPHAN-CANCEL-SEQ-001: Global serial chain untuk orphan cancel per account+apikey.
// Lighter exchange mewajibkan new_nonce = old_nonce + 1 (docs: signing-transactions.md).
// Karena strategy yang berbeda bisa share apiKeyIndex yang sama, nonce allocation yang
// sudah serial via acquireNonce belum cukup — sendTx dari dua strategy bisa tetap
// interleave dan tiba out-of-order di sequencer.
// Chain ini memastikan acquire+send tiap orphan cancel adalah atomic: strategy berikutnya
// baru bisa mulai setelah strategy sebelumnya selesai kirim ke exchange.
const _orphanCancelChain = new Map<string, Promise<void>>();

export function enqueueOrphanCancel(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network,
  task: () => Promise<void>
): Promise<void> {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  const prev = _orphanCancelChain.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // lanjut meski prev gagal, tiap task punya error handler sendiri
  _orphanCancelChain.set(key, next);
  return next;
}

/**
 * Mengembalikan promise chain orphan cancel yang sedang berjalan untuk
 * (network:accountIndex:apiKeyIndex). Digunakan oleh lighterBotEngine
 * untuk menunggu pending orphan cancel selesai sebelum mengirim order baru,
 * tanpa perlu akses langsung ke Map internal.
 */
export function waitForOrphanCancels(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network
): Promise<void> {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  return _orphanCancelChain.get(key) ?? Promise.resolve();
}

export async function acquireNonce(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network,
  count: number = 1
): Promise<number> {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  const myVersion = _nonceVersion.get(key) ?? 0;
  const prevChain = _nonceChain.get(key) ?? Promise.resolve(0);

  const nextChain: Promise<number> = prevChain.then(
    async () => {
      const cached = _nonceValue.get(key);
      if (cached !== undefined) {
        _nonceValue.set(key, cached + count);
        return cached;
      }
      const nonce = await getNextNonce(accountIndex, apiKeyIndex, network);
      // Only write to cache if not invalidated while this fetch was in-flight
      if ((_nonceVersion.get(key) ?? 0) === myVersion) {
        _nonceValue.set(key, nonce + count);
      }
      return nonce;
    },
    async () => {
      // Previous acquisition failed — re-fetch fresh nonce from API
      const nonce = await getNextNonce(accountIndex, apiKeyIndex, network);
      if ((_nonceVersion.get(key) ?? 0) === myVersion) {
        _nonceValue.set(key, nonce + count);
      }
      return nonce;
    }
  );

  _nonceChain.set(key, nextChain);
  return nextChain;
}

export function invalidateNonceCache(accountIndex: number, apiKeyIndex: number, network: Network): void {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  // NONCE-RACE-001 FIX: Jangan hapus _nonceChain saat invalidasi.
  // Sebelumnya: _nonceChain.delete(key) → caller baru mulai dari Promise.resolve(0), TIDAK menunggu
  // in-flight promise yang sedang memanggil getNextNonce. Kedua caller (in-flight lama + baru) bisa
  // memanggil getNextNonce secara concurrent dan mendapat nonce yang sama → collision di sequencer.
  //
  // Fix: hapus hanya cached VALUE (_nonceValue), biarkan chain tetap ada.
  // Caller baru akan chain setelah in-flight promise selesai (bukan dari Promise.resolve(0)).
  // Setelah in-flight selesai: cache sudah didelete dan version-nya berbeda → caller baru
  // masuk ke success/error handler dan memanggil getNextNonce dengan benar setelah in-flight selesai.
  // Version bump tetap diperlukan untuk mencegah in-flight lama menulis nonce stale ke cache.
  _nonceValue.delete(key);
  _nonceVersion.set(key, (_nonceVersion.get(key) ?? 0) + 1);
}

export function shouldInvalidateNonce(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err instanceof Error && err.name === "AbortError") ||
    msg.includes("timeout") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.toLowerCase().includes("nonce") ||
    msg.includes("HTTP 400")
  );
}
