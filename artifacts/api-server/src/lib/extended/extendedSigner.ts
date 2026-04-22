import { ec, num, shortString, hash } from "starknet";
import { logger } from "../logger";
import type { ExtendedNetwork } from "./extendedApi";

// ─── Algoritma signing Extended Exchange (Poseidon / SNIP-12-like) ────────────
//
// Dikonfirmasi dari source Rust x10xchange:
// https://github.com/x10xchange/rust-crypto-lib-base/blob/main/src/starknet_messages.rs
//
// Rust menggunakan PoseidonHasher (BUKAN Pedersen) dengan struktur berikut:
//
// ORDER HASH = Poseidon([
//   ORDER_SELECTOR,
//   position_id,       // u32 → felt (l2Vault, e.g. 364658)
//   base_asset_id,     // felt (syntheticId — SELALU synthetic, tidak berubah berdasarkan arah)
//   base_amount,       // i64 → felt (BUY: +syntheticQty, SELL: -syntheticQty)
//   quote_asset_id,    // felt (collateralId — SELALU collateral)
//   quote_amount,      // i64 → felt (BUY: -collateralAmount, SELL: +collateralAmount)
//   fee_asset_id,      // felt (sama dengan collateralId)
//   fee_amount,        // u64 → felt (unsigned, absolute value)
//   expiration.seconds,// u64 → felt (Unix timestamp dalam DETIK, bukan jam!)
//   salt,              // felt (nonce acak)
// ])
//
// MESSAGE HASH = Poseidon([MESSAGE_FELT, domain.hash(), public_key, order.hash()])
//
// DOMAIN HASH = Poseidon([DOMAIN_SELECTOR, "Perpetuals", "v0", chain_id, 1])
//
// PENTING: base_asset_id SELALU syntheticId (tidak di-swap berdasarkan BUY/SELL).
// Arah order dikodekan oleh TANDA (sign) dari base_amount dan quote_amount (i64 signed).
//
// Selector dikonfirmasi dari test Rust:
// Order::SELECTOR = 0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112
// DOMAIN_SELECTOR = 0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210

// ─── Konstanta ────────────────────────────────────────────────────────────────

// Order type selector: dikonfirmasi dari Rust test test_order_selector()
const ORDER_SELECTOR = BigInt(
  "0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112"
);

// Domain selector: dikonfirmasi dari Rust test test_starknet_domain_selector()
const DOMAIN_SELECTOR = BigInt(
  "0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210"
);

// "StarkNet Message" sebagai felt (cairo_short_string_to_felt equivalent)
const MESSAGE_FELT = BigInt(shortString.encodeShortString("StarkNet Message"));

// Chain ID Starknet mainnet
const CHAIN_IDS: Record<ExtendedNetwork, string> = {
  mainnet: "SN_MAIN",
};

// Field prime Starknet (P = 2^251 + 17*2^192 + 1)
// Digunakan untuk konversi i64 negatif → field element: -x menjadi P - x
const FIELD_PRIME =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

// ─── Public types ─────────────────────────────────────────────────────────────

export type ExtendedOrderSide = "BUY" | "SELL";

export interface SignOrderParams {
  privateKey: string;
  market: string;
  /**
   * Starknet synthetic asset ID dari l2Config.syntheticId.
   * SELALU digunakan sebagai base_asset_id (tidak di-swap berdasarkan arah).
   */
  syntheticId: string;
  /**
   * Starknet collateral asset ID dari l2Config.collateralId.
   * SELALU digunakan sebagai quote_asset_id dan fee_asset_id.
   */
  collateralId: string;
  side: ExtendedOrderSide;
  /**
   * Jumlah base asset (desimal string), e.g. "0.001".
   * Dikonversi ke integer menggunakan syntheticResolution.
   * Sign otomatis: BUY → positif, SELL → negatif.
   */
  qty: string;
  /**
   * Harga (desimal string), e.g. "43445.1168".
   * Dikonversi ke integer menggunakan collateralResolution.
   * Sign otomatis: BUY → negatif, SELL → positif.
   */
  price: string;
  nonce: number;
  /**
   * Waktu kedaluwarsa order (epoch milliseconds) — TANPA buffer 14 hari.
   * Untuk signing, +14 hari ditambahkan secara otomatis dan dikonversi ke DETIK:
   * expirationSeconds = ceil((expiryEpochMillis + 14 hari) / 1000)
   */
  expiryEpochMillis: number;
  /**
   * Fee rate sebagai desimal string, e.g. "0.0005" untuk 0.05%.
   * fee_amount = ceil(feeRate × |collateralAmount|)
   */
  fee: string;
  /** collateralPosition = l2Vault dari account info (position_id). */
  collateralPosition: string;
  /**
   * Resolusi synthetic asset dari l2Config.syntheticResolution.
   * Wajib — berbeda per market (BTC=1_000_000, ETH=100_000, dll).
   */
  syntheticResolution: number;
  /** Resolusi collateral dari l2Config.collateralResolution. Default 10^6. */
  collateralResolution?: number;
  network?: ExtendedNetwork;
}

export interface ExtendedSettlement {
  signature: { r: string; s: string };
  starkKey: string;
  collateralPosition: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function generateNonce(): number {
  const max = 2_147_483_647; // u32 max
  return Math.max(1, Math.floor(Math.random() * max));
}

export function derivePublicKey(privateKey: string): string {
  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  return ec.starkCurve.getStarkKey(pk);
}

// ─── Field element conversion ──────────────────────────────────────────────────
// Konversi nilai integer (termasuk i64 negatif) ke field element Starknet.
// -x → P - x (sama seperti i64::into::<Felt>() di Rust)

function toFelt(n: bigint): bigint {
  return ((n % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;
}

// ─── Decimal parser tanpa floating point ──────────────────────────────────────
// Mengkonversi string desimal ke { num: bigint, den: bigint } untuk aritmatika eksak.

function _parseDecimal(s: string): { num: bigint; den: bigint } {
  const trimmed = s.trim();
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx === -1) {
    return { num: BigInt(trimmed), den: 1n };
  }
  const intPart = trimmed.slice(0, dotIdx);
  const fracPart = trimmed.slice(dotIdx + 1);
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart) * den + BigInt(fracPart);
  return { num, den };
}

// ─── Domain hash ──────────────────────────────────────────────────────────────
// Dikonfirmasi dari Rust test test_starknet_domain_hashing()
// DOMAIN HASH = Poseidon([DOMAIN_SELECTOR, name_felt, version_felt, chain_id_felt, revision])

function computeDomainHash(network: ExtendedNetwork): bigint {
  const chainId = CHAIN_IDS[network];
  return BigInt(
    hash.computePoseidonHashOnElements([
      DOMAIN_SELECTOR,
      BigInt(shortString.encodeShortString("Perpetuals")),
      BigInt(shortString.encodeShortString("v0")),
      BigInt(shortString.encodeShortString(chainId)),
      1n, // revision
    ])
  );
}

// ─── Order hash ───────────────────────────────────────────────────────────────
// Sesuai Rust Order.hash() dari rust-crypto-lib-base/src/starknet_messages.rs

function computeOrderHash(params: {
  positionId: bigint;        // u32 (l2Vault)
  baseAssetId: bigint;       // felt — SELALU syntheticId
  baseAmount: bigint;        // i64: BUY → +syntheticQty, SELL → -syntheticQty
  quoteAssetId: bigint;      // felt — SELALU collateralId
  quoteAmount: bigint;       // i64: BUY → -collateralAmount, SELL → +collateralAmount
  feeAssetId: bigint;        // felt — sama dengan collateralId
  feeAmount: bigint;         // u64 (unsigned, absolute value)
  expirationSeconds: bigint; // u64 (Unix DETIK, dengan +14 hari buffer)
  salt: bigint;              // felt (nonce)
}): bigint {
  return BigInt(
    hash.computePoseidonHashOnElements([
      ORDER_SELECTOR,
      params.positionId,              // u32 → felt, always positive
      params.baseAssetId,             // felt, always positive
      toFelt(params.baseAmount),      // i64 → felt (handle negative)
      params.quoteAssetId,            // felt, always positive
      toFelt(params.quoteAmount),     // i64 → felt (handle negative)
      params.feeAssetId,              // felt, always positive
      params.feeAmount,               // u64 → felt, always positive
      params.expirationSeconds,       // u64 → felt, always positive
      params.salt,                    // felt, always positive
    ])
  );
}

// ─── Message hash ─────────────────────────────────────────────────────────────
// MESSAGE HASH = Poseidon([MESSAGE_FELT, domain.hash(), public_key, order.hash()])

function computeMessageHash(
  domainHash: bigint,
  publicKey: bigint,
  orderHash: bigint
): bigint {
  return BigInt(
    hash.computePoseidonHashOnElements([
      MESSAGE_FELT,
      domainHash,
      publicKey,
      orderHash,
    ])
  );
}

// ─── Core signing function ────────────────────────────────────────────────────

/**
 * Menandatangani order untuk Extended Perpetuals DEX (x10xchange).
 *
 * Menggunakan algoritma Poseidon / SNIP-12 sesuai source Rust x10xchange:
 *   https://github.com/x10xchange/rust-crypto-lib-base/blob/main/src/starknet_messages.rs
 *
 * PENTING: base_asset_id SELALU syntheticId (tidak di-swap berdasarkan BUY/SELL).
 * Arah dikodekan oleh sign dari base_amount dan quote_amount (i64 signed).
 * Expiration dalam DETIK (bukan jam): expirationSeconds = ceil((expiryMs + 14 hari) / 1000)
 */
export function signOrder(params: SignOrderParams): ExtendedSettlement {
  const {
    privateKey,
    market,
    syntheticId,
    collateralId,
    side,
    qty,
    price,
    nonce,
    expiryEpochMillis,
    fee,
    collateralPosition,
    syntheticResolution,
    collateralResolution = 1_000_000,
    network = "mainnet",
  } = params;

  if (!syntheticId) {
    throw new Error(
      `[ExtendedSigner] syntheticId wajib untuk market ${market}. ` +
        `Ambil dari GET /api/v1/info/markets → l2Config.syntheticId`
    );
  }
  if (!collateralId) {
    throw new Error(
      `[ExtendedSigner] collateralId wajib untuk market ${market}. ` +
        `Ambil dari GET /api/v1/info/markets → l2Config.collateralId`
    );
  }
  if (!syntheticResolution || syntheticResolution <= 0) {
    throw new Error(
      `[ExtendedSigner] syntheticResolution wajib untuk market ${market}. ` +
        `Ambil dari GET /api/v1/info/markets → l2Config.syntheticResolution`
    );
  }

  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const starkKey = ec.starkCurve.getStarkKey(pk);
  const publicKeyBig = BigInt(starkKey);

  // ── Asset IDs (tidak berubah berdasarkan BUY/SELL) ─────────────────────────
  // base = selalu synthetic, quote = selalu collateral
  const syntheticIdBig = BigInt(syntheticId);
  const collateralIdBig = BigInt(collateralId);

  // ── Amount computation (tanpa floating point, presisi eksak) ────────────────
  const qtyDecimal = _parseDecimal(qty);
  const priceDecimal = _parseDecimal(price);
  const feeRateDecimal = _parseDecimal(fee);

  const colResN = BigInt(collateralResolution);
  const synResN = BigInt(syntheticResolution);

  // synthetic_amount (unsigned, selalu positif)
  const syntheticRaw = qtyDecimal.num * synResN;
  const syntheticRem = syntheticRaw % qtyDecimal.den;
  const syntheticAmountUnsigned =
    syntheticRaw / qtyDecimal.den + (syntheticRem > 0n ? 1n : 0n);

  // collateral_amount (unsigned, selalu positif)
  const collateralRaw = qtyDecimal.num * priceDecimal.num * colResN;
  const collateralDen = qtyDecimal.den * priceDecimal.den;
  const collateralRem = collateralRaw % collateralDen;
  const collateralAmountUnsigned =
    collateralRaw / collateralDen + (collateralRem > 0n ? 1n : 0n);

  // fee_amount (unsigned, selalu positif)
  const feeRaw = feeRateDecimal.num * collateralAmountUnsigned;
  const feeDen = feeRateDecimal.den;
  const feeRem = feeRaw % feeDen;
  const feeAmount = feeRaw / feeDen + (feeRem > 0n ? 1n : 0n);

  // ── Signed amounts (i64 convention sesuai Rust) ─────────────────────────────
  // BUY:  base_amount > 0 (menerima synthetic), quote_amount < 0 (membayar collateral)
  // SELL: base_amount < 0 (mengirim synthetic), quote_amount > 0 (menerima collateral)
  let baseAmount: bigint;
  let quoteAmount: bigint;

  if (side === "BUY") {
    baseAmount = syntheticAmountUnsigned;      // +qty
    quoteAmount = -collateralAmountUnsigned;   // -collateral
  } else {
    baseAmount = -syntheticAmountUnsigned;     // -qty
    quoteAmount = collateralAmountUnsigned;    // +collateral
  }

  // ── Expiration dalam DETIK (sesuai Rust Timestamp.seconds) ─────────────────
  // Python SDK: __calc_settlement_expiration() → menambahkan +14 hari, lalu ke DETIK
  // expirationSeconds = ceil((expiryEpochMillis + 14 hari) / 1000)
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const expiryWithBufferMs = expiryEpochMillis + FOURTEEN_DAYS_MS;
  const expirationSeconds = BigInt(Math.ceil(expiryWithBufferMs / 1000));

  // ── Hash computation (sesuai Rust Order.hash() dan OffChainMessage.message_hash()) ─
  const positionId = BigInt(collateralPosition);
  const saltFelt = BigInt(nonce);

  const domainHash = computeDomainHash(network);
  const orderHash = computeOrderHash({
    positionId,
    baseAssetId: syntheticIdBig,
    baseAmount,
    quoteAssetId: collateralIdBig,
    quoteAmount,
    feeAssetId: collateralIdBig,
    feeAmount,
    expirationSeconds,
    salt: saltFelt,
  });
  const msgHash = computeMessageHash(domainHash, publicKeyBig, orderHash);

  const msgHashHex = num.toHex(msgHash);

  logger.info(
    {
      market,
      side,
      syntheticId,
      collateralId,
      baseAmount: baseAmount.toString(),       // signed (negatif untuk SELL)
      quoteAmount: quoteAmount.toString(),     // signed (negatif untuk BUY)
      feeAmount: feeAmount.toString(),
      expirationSeconds: expirationSeconds.toString(),
      positionId: positionId.toString(),
      nonce,
      domainHash: num.toHex(domainHash),
      orderHash: num.toHex(orderHash),
      msgHash: msgHashHex,
      algorithm: "Poseidon-SNIP12",
    },
    "[ExtendedSigner] Signing order (Poseidon)"
  );

  const signature = ec.starkCurve.sign(msgHashHex, pk);
  const r = num.toHex(signature.r);
  const s = num.toHex(signature.s);

  logger.debug(
    { market, side, nonce, starkKey, r, s },
    "[ExtendedSigner] Order signed"
  );

  return {
    signature: { r, s },
    starkKey,
    collateralPosition,
  };
}

// ─── Verifikasi signature (untuk debugging) ──────────────────────────────────

export function verifyOrderSignature(
  settlement: ExtendedSettlement,
  msgHash: string
): boolean {
  try {
    const sigHex = `${settlement.signature.r}${settlement.signature.s.replace(/^0x/, "")}`;
    const result = ec.starkCurve.verify(sigHex as any, msgHash, settlement.starkKey);
    return result;
  } catch (err) {
    logger.warn({ err }, "[ExtendedSigner] Signature verification failed");
    return false;
  }
}
