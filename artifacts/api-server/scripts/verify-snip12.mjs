// Deep analysis: @scure/starknet poseidonHashMany vs Rust PoseidonHasher
// Menggunakan test vector konkret dari Rust library

import { num, shortString, hash } from "starknet";

const PRIME = BigInt("3618502788666131213697322783095070105526743751716087489154079457884512865583");
const MESSAGE_FELT = BigInt(shortString.encodeShortString("StarkNet Message"));

function poseidonArr(arr) { return BigInt(hash.computePoseidonHashOnElements(arr)); }
function toField(n) { return n < 0n ? PRIME + n : n; }

// ─── Analisis @scure/starknet poseidonHashMany ────────────────────────────────
// Dari source code yang kita baca:
// 1. Copy array, tambah 1n di akhir
// 2. Pad dengan 0n sampai kelipatan rate=2
// 3. Absorb blok-blok 2, apply permutation setelah setiap blok
//
// Untuk 10 elemen: padded = [e0..e9, 1n, 0n] → 12 elemen = 6 blok
// Untuk 4 elemen:  padded = [e0..e3, 1n, 0n] → 6 elemen = 3 blok
// Untuk 5 elemen:  padded = [e0..e4, 1n]     → 6 elemen = 3 blok
// Untuk 11 elemen: padded = [e0..e10, 1n]    → 12 elemen = 6 blok

// Bandingkan dengan Rust PoseidonHasher (buffer approach):
// Untuk 10 elemen: 5 pairs absorb, finalize: state[0]+=1, permute → mirip blok terakhir (1,0)
// Untuk 4 elemen: 2 pairs absorb, finalize: state[0]+=1, permute → mirip blok terakhir (1,0)

// PERTANYAAN: Kenapa LimitOrder (11 elemen) match tapi Order (10 elemen) tidak?
// Mungkin padding @scure untuk 11 elemen: padded=[e0..e10, 1n] → 12 elemen
// Rust untuk 11 elemen: 5 pairs absorb + e10 in buffer, finalize: state[0]+=e10, state[1]+=1, permute
// @scure block 6: state[0]+=e10, state[1]+=1n, permute → SAMA!

// Dan untuk 10 elemen:
// Rust: 5 pairs, finalize: state[0]+=1, permute
// @scure block 6: state[0]+=1n, state[1]+=0n, permute
// Rust: state[0]+=1 TANPA menambah 0 ke state[1] sebelum permute
// @scure: state[0]+=1, state[1]+=0 → state[1] tidak berubah karena +=0
// SECARA MATEMATIS INI SAMA! 

// Jadi kenapa tidak match?! 

console.log("═══ Verifikasi sederhana: 2 elemen (EVEN) ═══");
// Rust PoseidonHasher untuk [1, 2]:
// update(1): buffer=1
// update(2): state[0]+=1, state[1]+=2, permute; buffer=None
// finalize(): state[0]+=1, permute; return state[0]
// = 2 permutations

// @scure poseidonHashMany([1, 2]):
// padded = [1, 2, 1, 0] → 4 elemen = 2 blok
// Block 1: state[0]+=1, state[1]+=2, permute → SAME as Rust step 1
// Block 2: state[0]+=1, state[1]+=0, permute → SAME as Rust finalize
// SHOULD MATCH!
const h2even = poseidonArr([1n, 2n]);
console.log(`poseidonArr([1, 2]) = 0x${h2even.toString(16)}`);

// Juga coba 1 elemen (ODD):
// @scure: padded=[1,1] → 2 elemen = 1 blok: state[0]+=1, state[1]+=1, permute
// Rust: update(1): buffer=1; finalize(): state[0]+=1, state[1]+=1, permute
// SAME!
const h1 = poseidonArr([1n]);
console.log(`poseidonArr([1])    = 0x${h1.toString(16)}`);

console.log("\n═══ ANALISIS: Apakah ORDER_SELECTOR sama dg Rust? ═══");
// Rust ORDER_SELECTOR string PERSIS:
const RUST_ORDER_STR = '"Order"("position_id":"felt","base_asset_id":"AssetId","base_amount":"i64","quote_asset_id":"AssetId","quote_amount":"i64","fee_asset_id":"AssetId","fee_amount":"u64","expiration":"Timestamp","salt":"felt")"PositionId"("value":"u32")"AssetId"("value":"felt")"Timestamp"("seconds":"u64")';

// Kita juga akan coba berbagai variasi dari type string untuk melihat mana yang match
const VARIANT_ORDER_STRS = [
  // Tanpa PositionId (yang kita pikir dulu benar)
  '"Order"("position_id":"felt","base_asset_id":"AssetId","base_amount":"i64","quote_asset_id":"AssetId","quote_amount":"i64","fee_asset_id":"AssetId","fee_amount":"u64","expiration":"Timestamp","salt":"felt")"AssetId"("value":"felt")"Timestamp"("seconds":"u64")',
  // Dengan PositionId (dari Rust)
  RUST_ORDER_STR,
  // position_id sebagai PositionId type
  '"Order"("position_id":"PositionId","base_asset_id":"AssetId","base_amount":"i64","quote_asset_id":"AssetId","quote_amount":"i64","fee_asset_id":"AssetId","fee_amount":"u64","expiration":"Timestamp","salt":"felt")"PositionId"("value":"u32")"AssetId"("value":"felt")"Timestamp"("seconds":"u64")',
];

const selectors = VARIANT_ORDER_STRS.map(s => BigInt(hash.getSelectorFromName(s)));
console.log("ORDER_SELECTOR variants:");
selectors.forEach((s, i) => console.log(`  [${i}]: 0x${s.toString(16)}`));
console.log(`  Hardcoded: 0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112`);

// ─── Test Vector 1: get_order_hash dengan TV1 values ───────────────────────────
console.log("\n═══ TV1: Order msg hash (semua kombinasi selector) ═══");
// Domain setup (testnet)
const DOMAIN_SELECTOR = BigInt(hash.getSelectorFromName(
  '"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")'
));
const domainHash = poseidonArr([
  DOMAIN_SELECTOR,
  BigInt(shortString.encodeShortString("Perpetuals")),
  BigInt(shortString.encodeShortString("v0")),
  BigInt(shortString.encodeShortString("SN_SEPOLIA")),
  1n,
]);

const TV1_EXPECTED = BigInt("0x4de4c009e0d0c5a70a7da0e2039fb2b99f376d53496f89d9f437e736add6b48");
const TV1_PUBKEY = BigInt("0x5d05989e9302dcebc74e241001e3e3ac3f4402ccf2f8e6f74b034b07ad6a904");

console.log(`Domain hash: 0x${domainHash.toString(16)}`);
console.log(`Expected:    0x${TV1_EXPECTED.toString(16)}`);

for (let si = 0; si < selectors.length; si++) {
  const sel = selectors[si];
  const orderElems = [sel, 100n, 0x2n, 100n, 0x1n, toField(-156n), 0x1n, 74n, 100n, 123n];
  const orderHash = poseidonArr(orderElems);
  
  // Coba berbagai urutan message hash
  const variants = [
    [MESSAGE_FELT, domainHash, TV1_PUBKEY, orderHash],
    [MESSAGE_FELT, domainHash, orderHash, TV1_PUBKEY],
    [domainHash, TV1_PUBKEY, orderHash],
  ];
  
  for (const [vi, elems] of variants.entries()) {
    const mh = poseidonArr(elems);
    if (mh === TV1_EXPECTED) {
      console.log(`\n✓ MATCH! selector[${si}], msg variant[${vi}]:`);
      console.log(`  orderHash: 0x${orderHash.toString(16)}`);
      console.log(`  msgHash:   0x${mh.toString(16)}`);
    }
  }
}
console.log("Selesai mencoba semua kombinasi.");

// ─── Cek: apakah menggunakan poseidonHash (2-arg) berbeda? ────────────────────
console.log("\n═══ Bandingkan poseidonHash vs poseidonHashMany untuk 2 args ═══");
const { poseidon: poseidonModule } = await import("starknet");
console.log("poseidon module:", Object.keys(poseidonModule || {}));
