import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import { logger } from "../logger";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SignResult {
  txType: number;
  txInfo: string;
  txHash: string;
  err: string | null;
}

export interface GenerateApiKeyResult {
  privateKey: string;
  publicKey: string;
  err: string | null;
}

// Chain ID mainnet sesuai lighter-python SDK (chain_id=304 for mainnet)
const CHAIN_ID_MAINNET = 304;

function getChainId(_url: string): number {
  return CHAIN_ID_MAINNET;
}

// L-001 FIX: Guard agar fnCreateClient tidak dipanggil berulang untuk tuple
// (privateKey, apiKeyIndex, accountIndex) yang sama. Key berisi privateKey hash
// (bukan plain text) — gunakan substring 8 char sebagai fingerprint.
// Jika privateKey berubah (rotasi key), guard di-reset otomatis.
const _signerInitCache = new Map<string, boolean>();

function getSignerCacheKey(privateKey: string, apiKeyIndex: number, accountIndex: number): string {
  return `${privateKey.slice(0, 8)}:${apiKeyIndex}:${accountIndex}`;
}

let koffi: any = null;
let lib: any = null;
let fnCreateClient: any = null;
let fnSignCreateOrder: any = null;
let fnSignCancelOrder: any = null;
let fnSignChangePubKey: any = null;
let fnGenerateAPIKey: any = null;
let fnCreateAuthToken: any = null;
let fnSignCancelAllOrders: any = null;
let fnFree: any = null;
let SignedTxResponseType: any = null;
let ApiKeyResponseType: any = null;
let StrOrErrType: any = null;

function loadLib(): void {
  if (lib) return;

  try {
    koffi = require("koffi");
  } catch (err) {
    throw new Error(`Failed to import koffi: ${err}`);
  }

  const soPath = path.join(__dirname, "..", "signers", "lighter-signer-linux-amd64.so");

  try {
    lib = koffi.load(soPath);
  } catch (err) {
    throw new Error(`Failed to load lighter signer .so from ${soPath}: ${err}`);
  }

  StrOrErrType = koffi.struct("StrOrErr", {
    str: "char *",
    err: "char *",
  });

  SignedTxResponseType = koffi.struct("SignedTxResponse", {
    txType: "uint8",
    txInfo: "char *",
    txHash: "char *",
    messageToSign: "char *",
    err: "char *",
  });

  ApiKeyResponseType = koffi.struct("ApiKeyResponse", {
    privateKey: "char *",
    publicKey: "char *",
    err: "char *",
  });

  fnCreateClient = lib.func(
    "CreateClient",
    "char *",
    ["char *", "char *", "int", "int", "long long"]
  );

  fnGenerateAPIKey = lib.func(
    "GenerateAPIKey",
    ApiKeyResponseType,
    []
  );

  // CreateAuthToken(cDeadline int64, cApiKeyIndex int, cAccountIndex int64) StrOrErr
  // Per header resmi v1.0.5 — return type adalah StrOrErr struct {str, err}, BUKAN char*.
  // deadline = 0 → default 7-hour expiry (server clamps to max 8 h)
  fnCreateAuthToken = lib.func(
    "CreateAuthToken",
    StrOrErrType,
    ["long long", "int", "long long"] // cDeadline, cApiKeyIndex, cAccountIndex
  );

  // SignChangePubKey(newPubKey char*, cSkipNonce uint8, nonce int64, apiKeyIndex int, accountIndex int64) SignedTxResponse
  // v1.0.6: cSkipNonce added as 2nd param
  fnSignChangePubKey = lib.func(
    "SignChangePubKey",
    SignedTxResponseType,
    [
      "char *",    // newPubKey
      "uint8",     // cSkipNonce (1 = use caller nonce, 0 = library manages)
      "long long", // nonce
      "int",       // apiKeyIndex
      "long long", // accountIndex
    ]
  );

  // v1.0.6: cSkipNonce uint8 added before cNonce (position 14)
  fnSignCreateOrder = lib.func(
    "SignCreateOrder",
    SignedTxResponseType,
    [
      "int",       // cMarketIndex
      "long long", // cClientOrderIndex
      "long long", // cBaseAmount
      "int",       // cPrice
      "int",       // cIsAsk
      "int",       // cOrderType
      "int",       // cTimeInForce
      "int",       // cReduceOnly
      "int",       // cTriggerPrice
      "long long", // cOrderExpiry
      "long long", // cIntegratorAccountIndex
      "int",       // cIntegratorTakerFee
      "int",       // cIntegratorMakerFee
      "uint8",     // cSkipNonce (1 = use caller nonce)
      "long long", // cNonce
      "int",       // cApiKeyIndex
      "long long", // cAccountIndex
    ]
  );

  // SignCancelOrder(cMarketIndex int, cOrderIndex int64, cSkipNonce uint8, cNonce int64, cApiKeyIndex int, cAccountIndex int64) SignedTxResponse
  // v1.0.6: cSkipNonce added before cNonce
  fnSignCancelOrder = lib.func(
    "SignCancelOrder",
    SignedTxResponseType,
    [
      "int",       // cMarketIndex
      "long long", // cOrderIndex
      "uint8",     // cSkipNonce (1 = use caller nonce)
      "long long", // cNonce
      "int",       // cApiKeyIndex
      "long long", // cAccountIndex
    ]
  );

  // SignCancelAllOrders(cTimeInForce int, cTime int64, cSkipNonce uint8, cNonce int64, cApiKeyIndex int, cAccountIndex int64) SignedTxResponse
  // v1.0.6: cSkipNonce added before cNonce. Tidak dipakai di bot engine — hanya diekspos untuk keperluan manual.
  fnSignCancelAllOrders = lib.func(
    "SignCancelAllOrders",
    SignedTxResponseType,
    [
      "int",       // cTimeInForce (0 = semua time-in-force)
      "long long", // cTime (0 = semua, atau Unix timestamp cutoff)
      "uint8",     // cSkipNonce (1 = use caller nonce)
      "long long", // cNonce
      "int",       // cApiKeyIndex
      "long long", // cAccountIndex
    ]
  );

  fnFree = lib.func("Free", "void", ["void *"]);

  logger.info({ soPath }, "Lighter signer library loaded");
}

function readCStr(ptr: any): string | null {
  if (!ptr) return null;
  // koffi auto-converts char* struct fields to JS strings — handle both cases
  if (typeof ptr === "string") return ptr || null;
  try {
    return koffi.decode(ptr, "string") || null;
  } catch {
    return null;
  }
}

export function initSigner(
  url: string,
  privateKey: string,
  apiKeyIndex: number,
  accountIndex: number
): void {
  loadLib();

  // L-001 FIX: Skip CreateClient jika tuple (privateKey, apiKeyIndex, accountIndex) sudah diinisialisasi.
  // fnCreateClient (Go FFI) tidak idempotent — memanggil berkali-kali membuat client object baru
  // tanpa cleanup, menimbulkan memory leak di long-running server.
  const cacheKey = getSignerCacheKey(privateKey, apiKeyIndex, accountIndex);
  if (_signerInitCache.get(cacheKey)) {
    return;
  }

  const errPtr = fnCreateClient(url, privateKey, getChainId(url), apiKeyIndex, accountIndex);
  const err = readCStr(errPtr);
  if (errPtr) fnFree(errPtr);
  if (err) {
    throw new Error(`CreateClient failed: ${err}`);
  }
  _signerInitCache.set(cacheKey, true);
  logger.info({ apiKeyIndex, accountIndex, chainId: getChainId(url) }, "Lighter signer client initialized");
}

export function generateApiKey(): GenerateApiKeyResult {
  loadLib();
  const resp = fnGenerateAPIKey();
  const privateKey = readCStr(resp.privateKey);
  const publicKey = readCStr(resp.publicKey);
  const err = readCStr(resp.err);
  return {
    privateKey: privateKey ?? "",
    publicKey: publicKey ?? "",
    err,
  };
}

export interface ChangePubKeySignResult extends SignResult {
  messageToSign: string;
}

export function signChangePubKey(params: {
  url: string;
  newPubKey: string;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
}): ChangePubKeySignResult {
  loadLib();

  // CreateClient must be called first with the NEW private key so the signer
  // knows which key to use for signing
  const resp = fnSignChangePubKey(
    params.newPubKey,
    1,               // cSkipNonce = 1 (use caller nonce, not internal library)
    params.nonce,
    params.apiKeyIndex,
    params.accountIndex,
  );

  const txInfo = readCStr(resp.txInfo);
  const txHash = readCStr(resp.txHash);
  const messageToSign = readCStr(resp.messageToSign);
  const err = readCStr(resp.err);

  return {
    txType: resp.txType,
    txInfo: txInfo ?? "",
    txHash: txHash ?? "",
    messageToSign: messageToSign ?? "",
    err,
  };
}

export function signCreateOrder(params: {
  marketIndex: number;
  clientOrderIndex: number;
  baseAmount: number;
  price: number;
  isAsk: boolean;
  orderType: number;
  timeInForce: number;
  reduceOnly: boolean;
  triggerPrice: number;
  orderExpiry: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
}): SignResult {
  loadLib();

  const resp = fnSignCreateOrder(
    params.marketIndex,
    params.clientOrderIndex,
    params.baseAmount,
    params.price,
    params.isAsk ? 1 : 0,
    params.orderType,
    params.timeInForce,
    params.reduceOnly ? 1 : 0,
    params.triggerPrice,
    params.orderExpiry,
    0,  // integratorAccountIndex
    0,  // integratorTakerFee
    0,  // integratorMakerFee
    1,  // cSkipNonce = 1 (use caller nonce, not internal library)
    params.nonce,
    params.apiKeyIndex,
    params.accountIndex
  );

  const txInfo = readCStr(resp.txInfo);
  const txHash = readCStr(resp.txHash);
  const err = readCStr(resp.err);

  // Do NOT call fnFree on struct fields returned by value — koffi already
  // decoded them to JS strings; passing JS values to C Free() crashes the process.

  return {
    txType: resp.txType,
    txInfo: txInfo ?? "",
    txHash: txHash ?? "",
    err,
  };
}

export function signCancelOrder(params: {
  marketIndex: number;
  // L-005 FIX: parameter direname dari clientOrderIndex → orderIndex agar sesuai
  // dengan Go FFI: SignCancelOrder(cMarketIndex, cOrderIndex, ...).
  // Caller HARUS mengoper order_index yang di-assign exchange (dari fetchAccountActiveOrders
  // field "order_index"), bukan client_order_index (yang di-assign bot).
  // Untuk cancel order yang hanya ada di DB (tanpa live fetch), simpan order_index
  // dari exchange response saat order pertama kali dikonfirmasi.
  orderIndex: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
}): SignResult {
  loadLib();

  const resp = fnSignCancelOrder(
    params.marketIndex,
    params.orderIndex,
    1,  // cSkipNonce = 1 (use caller nonce, not internal library)
    params.nonce,
    params.apiKeyIndex,
    params.accountIndex
  );

  const txInfo = readCStr(resp.txInfo);
  const txHash = readCStr(resp.txHash);
  const err = readCStr(resp.err);

  return {
    txType: resp.txType,
    txInfo: txInfo ?? "",
    txHash: txHash ?? "",
    err,
  };
}

export function signCancelAllOrders(params: {
  timeInForce: number;
  time: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
}): SignResult {
  loadLib();

  const resp = fnSignCancelAllOrders(
    params.timeInForce,
    params.time,
    1,  // cSkipNonce = 1 (use caller nonce, not internal library)
    params.nonce,
    params.apiKeyIndex,
    params.accountIndex
  );

  const txInfo = readCStr(resp.txInfo);
  const txHash = readCStr(resp.txHash);
  const err = readCStr(resp.err);

  return {
    txType: resp.txType,
    txInfo: txInfo ?? "",
    txHash: txHash ?? "",
    err,
  };
}

export interface CreateAuthTokenResult {
  token: string | null;
  err: string | null;
}

/**
 * Generate a Lighter auth token using the official Go SDK.
 * The signer must be initialized via initSigner() first (CreateClient).
 *
 * @param deadlineUnix  - Unix timestamp (seconds) for token expiry.
 *                        Pass 0 for the default (~7 hours from now).
 *                        Server clamps to max 8 hours even if you pass further.
 * @param apiKeyIndex   - API key index, must match the initialized signer client.
 * @param accountIndex  - Account index, must match the initialized signer client.
 *
 * Token format: "{expiry_unix}:{account_index}:{api_key_index}:{random_hex}"
 * This is the Authorization header value required by Lighter's auth-gated endpoints:
 *   - /api/v1/deposit/history
 *   - /api/v1/withdraw/history
 *   - /api/v1/accountActiveOrders
 *   - etc.
 */
export function createAuthToken(
  deadlineUnix: number = 0,
  apiKeyIndex: number,
  accountIndex: number,
): CreateAuthTokenResult {
  loadLib();
  try {
    const resp = fnCreateAuthToken(deadlineUnix, apiKeyIndex, accountIndex);
    const token = readCStr(resp.str);
    const errMsg = readCStr(resp.err);
    if (errMsg) return { token: null, err: errMsg };
    return { token, err: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { token: null, err: msg };
  }
}

export function isSignerAvailable(): boolean {
  try {
    loadLib();
    return true;
  } catch {
    return false;
  }
}
