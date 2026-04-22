import Groq from "groq-sdk";
import { logger } from "./logger";

// ─── Multi-Key Pool ───────────────────────────────────────────────────────────
function loadApiKeys(): string[] {
  const keys: string[] = [];
  const primary = process.env.GROQ_API_KEY;
  if (primary) keys.push(primary);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

let _keyIndex = 0;
function getNextKey(keys: string[]): string {
  const key = keys[_keyIndex % keys.length];
  _keyIndex = (_keyIndex + 1) % keys.length;
  return key;
}

// ─── Auto Cascade - 5 Tier Model System ──────────────────────────────────────
const MODEL_TIERS = [
  { name: "llama-3.3-70b-versatile",                   dailyLimit: 1000,  quality: 10, description: "Premium (10/10)"  },
  { name: "openai/gpt-oss-120b",                        dailyLimit: 1000,  quality: 9,  description: "High (9/10)"     },
  { name: "openai/gpt-oss-20b",                         dailyLimit: 1000,  quality: 8,  description: "Good (8/10)"     },
  { name: "meta-llama/llama-4-scout-17b-16e-instruct",  dailyLimit: 1000,  quality: 7,  description: "Scout (7/10)"    },
  { name: "llama-3.1-8b-instant",                       dailyLimit: 14400, quality: 6,  description: "Standard (6/10)" },
];

// ─── System Prompt: Lighter DEX ───────────────────────────────────────────────
const LIGHTER_SYSTEM_PROMPT = `You are an expert algo trading assistant for the Lighter DEX (ZK-rollup on Ethereum). Analyze market data → recommend optimal Grid params.

IMPORTANT: "reasoning" in JSON MUST be Bahasa Indonesia (santai tapi expert). All other fields: English enums, numbers only.

<dex_context>
DEX: Lighter DEX (ZK-rollup Ethereum, perpetuals + spot)

Fees:
- Standard Account: maker 0%, taker 0% → LIMIT/Post-Only always superior to MARKET (no fee advantage either way, but Post-Only guarantees maker execution)
- Premium Account (LIT stake): maker 0.004%, taker 0.028% (up to 30% discount)

Latency: Standard 200-300ms | Premium LIT 140ms → Offset LEBAR wajib untuk mitigasi slippage
Latency-Offset Mapping:
  - Grid buy: 0.2-0.5% offset below market (+0.2% extra saat high vol >20% 24h range)
  - Grid sell: 0.2-0.5% offset above market (+0.2% extra saat high vol)
  - Alasan: Konfirmasi order 200-300ms → harga bisa bergerak sebelum fill, offset lebar jaga fill rate

Order Types: limit, post_only, market (avoid market — no fee benefit + slippage risk)
</dex_context>

## CORE STRATEGY LOGIC

### GRID
- Best for: sideways/ranging markets, support/resistance bounds
- Range: ±5-10% conservative | ±10-20% moderate | ±20-40% aggressive (vol >15% 24h)
- Levels: 5-10 tight (<10%) | 10-15 medium (10-20%) | 15-20 wide (>20%)
- Amount/grid: must fill all levels simultaneously; above exchange minimum
- Mode RULES (STRICT — MUST follow, no exceptions):
  - marketCondition = "bullish"  → mode MUST be "long"    (trending up → only buy dips, NEVER sell into rally)
  - marketCondition = "bearish"  → mode MUST be "short"   (trending down → only sell rallies, NEVER buy into dump)
  - marketCondition = "sideways" → mode MUST be "neutral"  (ranging → buy and sell within range)
  - marketCondition = "volatile" → mode MUST be "neutral"  (unpredictable → symmetric grid)
  - CRITICAL: NEVER set mode="neutral" when marketCondition is "bullish" or "bearish" — this trades against the trend and causes direct financial losses
- SL: REQUIRED as absolute price (NOT a percentage) for aggressive grids, optional for others
  - Formula: stopLoss = lowerPrice × (1 - 0.05 to 0.10)
  - Example: lowerPrice=$3000 → stopLoss=$2700–$2850
  - NEVER output stopLoss as a small number (e.g. 5, 10, 150) — always derive from lowerPrice
- TP: Optional as absolute price (NOT a percentage)
  - Formula: takeProfit = upperPrice × (1 + 0.05 to 0.10)
  - Example: upperPrice=$3500 → takeProfit=$3675–$3850
  - NEVER output takeProfit as a small number — always derive from upperPrice
- Order: POST-ONLY strongly preferred; LIMIT fallback if fills too rare

## RESPONSE FORMAT
Valid JSON only, no markdown, no extra text:
{
  "strategy": "grid",
  "grid_params": {
    "lowerPrice": number,
    "upperPrice": number,
    "gridLevels": number,
    "amountPerGrid": number,
    "mode": "neutral" | "long" | "short",
    "orderType": "limit" | "post_only",
    "limitPriceOffset": number,
    "stopLoss": number | null,
    "takeProfit": number | null
  } | null,
  "reasoning": string,
  "marketCondition": "bullish" | "bearish" | "sideways" | "volatile",
  "riskLevel": "low" | "medium" | "high",
  "volumeContext": "low" | "normal" | "high",
  "confidence": integer (0-100, where 100 = fully confident, 50 = uncertain — NEVER use 0.0-1.0 scale)
}`;

// ─── System Prompt: Extended Exchange ────────────────────────────────────────
const EXTENDED_SYSTEM_PROMPT = `You are an expert algo trading assistant for the Extended Exchange (hybrid off-chain/on-chain DEX on Starknet). Analyze market data → recommend optimal Grid params.

IMPORTANT: "reasoning" in JSON MUST be Bahasa Indonesia (santai tapi expert). All other fields: English enums, numbers only.

<dex_context>
DEX: Extended Exchange (Starknet hybrid off-chain, all markets are perpetual contracts, USDC-collateralized)

Fees:
- Maker: 0% base (+rebates 0.002-0.013% jika volume share >0.5% → PRIORITAS POST-ONLY untuk dapat rebates)
- Taker: 0.025% → HINDARI MARKET orders
→ POST-ONLY adalah pilihan terbaik: zero fee + potensi rebates aktif

Latency: <10ms (hybrid off-chain Starknet) → Offset TIPIS cukup karena eksekusi hampir instan
Latency-Offset Mapping:
  - Grid buy: 0.05-0.2% offset below market (+0.1% extra saat high vol >20% 24h range)
  - Grid sell: 0.05-0.2% offset above market (+0.1% extra saat high vol)
  - Alasan: Latency <10ms → slippage minimal, offset tipis sudah cukup → maksimalkan fill rate + rebates

Accounts: Cross-margin default + hingga 10 isolated sub-akun → Gunakan sub-akun terpisah untuk grid isolation, hindari cross-margin blow-up antar strategi
Collateral: USDC dan XVS vault (90% equity bisa dipakai, 24h lockup withdrawal)
Liquidation: Partial liquidation (margin call 66%/80%), insurance fund cap 15% per hari
Order Types: limit, post_only, market (avoid market — taker fee 0.025% + melewatkan rebates maker)
</dex_context>

## CORE STRATEGY LOGIC

### GRID
- Best for: sideways/ranging perpetual markets, support/resistance bounds
- Range: ±5-10% conservative | ±10-20% moderate | ±20-40% aggressive (vol >15% 24h)
- Levels: 5-10 tight (<10%) | 10-15 medium (10-20%) | 15-20 wide (>20%)
- Amount/grid: must fill all levels simultaneously; above exchange minimum
- Mode RULES (STRICT — MUST follow, no exceptions):
  - marketCondition = "bullish"  → mode MUST be "long"    (trending up → only buy dips, NEVER sell into rally)
  - marketCondition = "bearish"  → mode MUST be "short"   (trending down → only sell rallies, NEVER buy into dump)
  - marketCondition = "sideways" → mode MUST be "neutral"  (ranging → buy and sell within range)
  - marketCondition = "volatile" → mode MUST be "neutral"  (unpredictable → symmetric grid)
  - CRITICAL: NEVER set mode="neutral" when marketCondition is "bullish" or "bearish" — this trades against the trend and causes direct financial losses
- SL: 5-10% below range (wajib untuk aggressive grid, lindungi dari liquidation)
- TP: 5-10% above range (optional)
- Order: POST-ONLY strongly preferred (zero fee + rebates); LIMIT fallback
- Manfaatkan sub-akun isolated untuk setiap grid strategy — hindari cross-margin exposure

## RESPONSE FORMAT
Valid JSON only, no markdown, no extra text:
{
  "strategy": "grid",
  "grid_params": {
    "lowerPrice": number,
    "upperPrice": number,
    "gridLevels": number,
    "amountPerGrid": number,
    "mode": "neutral" | "long" | "short",
    "orderType": "limit" | "post_only",
    "limitPriceOffset": number,
    "stopLoss": number | null,
    "takeProfit": number | null
  } | null,
  "reasoning": string,
  "marketCondition": "bullish" | "bearish" | "sideways" | "volatile",
  "riskLevel": "low" | "medium" | "high",
  "volumeContext": "low" | "normal" | "high",
  "confidence": integer (0-100, where 100 = fully confident, 50 = uncertain — NEVER use 0.0-1.0 scale)
}`;


export interface MarketContext {
  exchange: "lighter" | "extended";
  symbol: string;
  type: "perp" | "spot";
  lastPrice: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  priceChangePct24h: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  availableBalance?: number;
  fundingRate?: number | null;  // dalam %, contoh: 0.01 = 0.01% per jam (Extended perp only)
  forcedMarketCondition?: "bullish" | "bearish" | "sideways" | "volatile"; // dikunci dari analisis bersama lintas exchange
}

export interface GridParams {
  lowerPrice: number;
  upperPrice: number;
  gridLevels: number;
  amountPerGrid: number;
  mode: "neutral" | "long" | "short";
  orderType: "limit" | "post_only";
  limitPriceOffset: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface AIAnalysisResult {
  strategy: "grid";
  grid_params: GridParams | null;
  reasoning: string;
  marketCondition: "bullish" | "bearish" | "sideways" | "volatile";
  riskLevel: "low" | "medium" | "high";
  volumeContext: "low" | "normal" | "high";
  confidence: number;
  modelUsed: string;
  modelTier: string;
}

function buildUserPrompt(strategyType: "grid", market: MarketContext): string {
  const range24h = market.high24h > 0 && market.low24h > 0
    ? `$${market.low24h.toFixed(2)} - $${market.high24h.toFixed(2)}`
    : "N/A";
  const volatility = market.high24h > 0 && market.low24h > 0
    ? `${(((market.high24h - market.low24h) / market.low24h) * 100).toFixed(1)}%`
    : "N/A";
  const priceChange24h = `${market.priceChangePct24h > 0 ? "+" : ""}${market.priceChangePct24h.toFixed(2)}%`;

  const fundingRateLine = (() => {
    if (market.exchange === "lighter" || market.fundingRate == null) return "";
    const fr = market.fundingRate;
    const sign = fr > 0 ? "+" : "";
    const bias = Math.abs(fr) > 0.01
      ? fr > 0
        ? " ⚠️ HIGH POSITIVE — longs paying shorts, bearish pressure on perp"
        : " ⚠️ HIGH NEGATIVE — shorts paying longs, bullish pressure on perp"
      : " (neutral)";
    return `\nFunding Rate (1h): ${sign}${fr.toFixed(4)}%${bias}`;
  })();

  const volumeContext = market.volume24h > 10e9 ? "high ($10B+)"
    : market.volume24h > 2e9 ? "normal ($2-10B)"
    : "low (<$2B)";

  const exchangeLabel = market.exchange === "extended"
    ? "Extended Exchange (StarkNet perp DEX)"
    : "Lighter DEX";

  const feeContext = market.exchange === "extended"
    ? "Maker fee 0%, Taker fee 0.025% — always use LIMIT/Post-Only to avoid taker fees"
    : "Standard Account: zero maker/taker fees — always prefer LIMIT/Post-Only";

  const forcedConditionBlock = market.forcedMarketCondition
    ? `\n⚠️ SHARED MARKET CONDITION LOCK — DO NOT OVERRIDE ⚠️
The market condition for ${market.symbol} has been pre-determined by a shared cross-exchange analysis as: "${market.forcedMarketCondition.toUpperCase()}"
You MUST set "marketCondition": "${market.forcedMarketCondition}" in your JSON response exactly as written.
You MUST set grid mode accordingly: ${
      market.forcedMarketCondition === "bullish" ? '"long"' :
      market.forcedMarketCondition === "bearish" ? '"short"' : '"neutral"'
    }
This lock ensures consistency across all exchanges analyzing the same market at the same time.
DO NOT use any other marketCondition value — ignoring this lock causes directly contradictory strategies across exchanges.\n`
    : "";

  return `Analyze this ${exchangeLabel} market and recommend optimal ${strategyType.toUpperCase()} strategy parameters.
IMPORTANT: All numbers in your JSON response MUST use a dot (.) as the decimal separator, never a comma. Example: 64956.4 not 64956,4.
${forcedConditionBlock}
Market: ${market.symbol} (${market.type})
Current Price: $${market.lastPrice.toFixed(4)}
24h Range: ${range24h}
24h Volatility: ${volatility}
24h Volume: $${market.volume24h.toFixed(0)} (${volumeContext})
24h Price Change: ${priceChange24h}${fundingRateLine}
Min Order Size (HARD LIMIT — MUST NOT GO BELOW): ${market.minBaseAmount} ${market.symbol.split("-")[0]} base OR $${market.minQuoteAmount} USDC quote, whichever is LARGER.
At current price $${market.lastPrice.toFixed(4)}, the minimum order in USDC = max($${market.minQuoteAmount}, ${market.minBaseAmount} × $${market.lastPrice.toFixed(4)}) = $${Math.max(market.minQuoteAmount, market.minBaseAmount * market.lastPrice).toFixed(2)} USDC.
You MUST set amountPerGrid to AT LEAST 1.5× this value = $${(Math.max(market.minQuoteAmount, market.minBaseAmount * market.lastPrice) * 1.5).toFixed(2)} USDC. Orders below minimum are silently skipped by the exchange.

Strategy Type: ${strategyType.toUpperCase()}
Execution: ${feeContext}
${(() => {
  const capital = market.availableBalance !== undefined
    ? `$${market.availableBalance.toFixed(2)} USDC (user's real available balance)`
    : "$1000 USDC (estimated)";
  return `Capital Available: ${capital}. Size amountPerGrid so all grid levels can be filled simultaneously, AND above the minimum stated above. Provide appropriate stop-loss.`;
})()}

Return ONLY valid JSON matching the specification. Ensure strategy and appropriate params are set, others null.`;
}

async function callWithCascade(
  keys: string[],
  messages: Groq.Chat.ChatCompletionMessageParam[],
  startTierIndex: number = 0
): Promise<{ content: string; modelUsed: string; tierDescription: string }> {
  for (let i = startTierIndex; i < MODEL_TIERS.length; i++) {
    const tier = MODEL_TIERS[i];

    let lastErrMsg = "";
    let modelUnavailable = false;
    for (let k = 0; k < keys.length; k++) {
      const apiKey = getNextKey(keys);
      const client = new Groq({ apiKey });
      try {
        logger.info({ model: tier.name, tier: tier.description, keySlot: k + 1, totalKeys: keys.length }, "Trying AI model tier");
        const response = await client.chat.completions.create({
          model: tier.name,
          messages,
          temperature: 0.3,
          max_tokens: 1200,
          response_format: { type: "json_object" },
        });

        const content = response.choices[0]?.message?.content ?? "";
        if (!content) throw new Error("Empty response from model");

        logger.info({ model: tier.name, keySlot: k + 1 }, "AI model responded successfully");
        return { content, modelUsed: tier.name, tierDescription: tier.description };
      } catch (err: any) {
        lastErrMsg = err?.message ?? String(err);
        const isRateLimit = lastErrMsg.includes("429") || lastErrMsg.includes("rate_limit") || lastErrMsg.includes("rate limit");
        modelUnavailable = lastErrMsg.includes("model") || lastErrMsg.includes("404") || lastErrMsg.includes("not found") || lastErrMsg.includes("decommissioned");

        logger.warn({ model: tier.name, keySlot: k + 1, err: lastErrMsg }, isRateLimit ? "Key rate-limited, trying next key" : "Model error");

        if (!isRateLimit) break;
      }
    }

    logger.warn({ model: tier.name, err: lastErrMsg }, `All keys failed for this tier, ${i < MODEL_TIERS.length - 1 ? "cascading to next tier" : "all tiers exhausted"}`);

    if (i === MODEL_TIERS.length - 1) {
      throw new Error(`All ${MODEL_TIERS.length} model tiers and ${keys.length} API key(s) exhausted. Last error: ${lastErrMsg}`);
    }
  }
  throw new Error("Cascade failed unexpectedly");
}

export async function analyzeMarketForStrategy(
  strategyType: "grid",
  market: MarketContext
): Promise<AIAnalysisResult> {
  const keys = loadApiKeys();
  if (keys.length === 0) {
    throw new Error("GROQ_API_KEY is not configured. Please add it in Settings → Environment.");
  }

  const systemPrompt = market.exchange === "extended" ? EXTENDED_SYSTEM_PROMPT
    : LIGHTER_SYSTEM_PROMPT;

  logger.info({ totalKeys: keys.length, exchange: market.exchange }, "AI analysis started with key pool");

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserPrompt(strategyType, market) },
  ];

  const { content, modelUsed, tierDescription } = await callWithCascade(keys, messages);

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`AI returned invalid JSON: ${content.substring(0, 200)}`);
  }

  const hasGrid = parsed.grid_params && typeof parsed.grid_params === "object";

  if (!hasGrid) {
    throw new Error("AI response missing grid_params");
  }

  // Normalisasi confidence: AI kadang return skala 0-1 (mis. 0.8) bukan 0-100 (80).
  // Berlaku untuk semua exchange karena semua prompt sudah punya instruksi skala, tapi AI bisa saja salah.
  if (typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1) {
    parsed.confidence = Math.round(parsed.confidence * 100);
  }

  // Safety net: jika forcedMarketCondition diberikan, timpa hasil AI sepenuhnya sebelum cek mode.
  // Ini mencegah AI mengembalikan kondisi berbeda dari yang sudah dikunci lintas exchange.
  if (market.forcedMarketCondition && parsed.marketCondition !== market.forcedMarketCondition) {
    logger.warn(
      { aiReturned: parsed.marketCondition, forced: market.forcedMarketCondition, exchange: market.exchange },
      "[groqAI] marketCondition dari AI berbeda dari forcedMarketCondition — ditimpa paksa"
    );
    parsed.marketCondition = market.forcedMarketCondition;
  }

  // Safety net mode grid: paksa mode sesuai marketCondition untuk semua exchange.
  // Mode yang salah (mis. neutral saat bullish) berarti bot menjual saat harga naik → kerugian finansial langsung.
  // Berlaku untuk Lighter dan Extended — keduanya perpetual dengan risiko yang sama.
  if (hasGrid && parsed.grid_params) {
    const mc: string = parsed.marketCondition ?? "";
    const exchLabel = market.exchange.charAt(0).toUpperCase() + market.exchange.slice(1);
    if (mc === "bullish" && parsed.grid_params.mode !== "long") {
      logger.warn({ original: parsed.grid_params.mode, corrected: "long", marketCondition: mc, exchange: market.exchange }, `[${exchLabel}] Mode dikoreksi paksa: bullish → long`);
      parsed.grid_params.mode = "long";
    } else if (mc === "bearish" && parsed.grid_params.mode !== "short") {
      logger.warn({ original: parsed.grid_params.mode, corrected: "short", marketCondition: mc, exchange: market.exchange }, `[${exchLabel}] Mode dikoreksi paksa: bearish → short`);
      parsed.grid_params.mode = "short";
    } else if ((mc === "sideways" || mc === "volatile") && parsed.grid_params.mode !== "neutral") {
      logger.warn({ original: parsed.grid_params.mode, corrected: "neutral", marketCondition: mc, exchange: market.exchange }, `[${exchLabel}] Mode dikoreksi paksa: sideways/volatile → neutral`);
      parsed.grid_params.mode = "neutral";
    }
  }

  // ─── Lighter Grid: Post-Process Validations ────────────────────────────────
  // Validasi tambahan khusus Lighter setelah AI response diterima.
  // Ini layer pertahanan kedua setelah instruksi prompt — tidak bergantung pada kebenaran AI.
  if (market.exchange === "lighter" && hasGrid && parsed.grid_params) {
    const gp = parsed.grid_params;
    const price = market.lastPrice;

    // [1] lowerPrice & upperPrice — resolusi dulu, lalu cek inversi
    gp.lowerPrice = gp.lowerPrice || price * 0.95;
    gp.upperPrice = gp.upperPrice || price * 1.05;
    if (gp.lowerPrice >= gp.upperPrice) {
      logger.warn({ lowerPrice: gp.lowerPrice, upperPrice: gp.upperPrice, price }, "[Lighter] Grid range terbalik — swap paksa");
      [gp.lowerPrice, gp.upperPrice] = [gp.upperPrice, gp.lowerPrice];
    }

    // [2] gridLevels — harus integer, clamp 3–20
    const rawLevels = Math.round(gp.gridLevels ?? 10);
    if (rawLevels < 3 || rawLevels > 20) {
      logger.warn({ original: gp.gridLevels, clamped: Math.max(3, Math.min(20, rawLevels)) }, "[Lighter] gridLevels di luar batas — diclamp");
    }
    gp.gridLevels = Math.max(3, Math.min(20, rawLevels));

    // [3] orderType — tolak "market", paksa "post_only"
    if (gp.orderType === "market") {
      logger.warn({ original: "market", corrected: "post_only" }, "[Lighter] orderType 'market' ditolak — paksa 'post_only'");
      gp.orderType = "post_only";
    }

    // [4] limitPriceOffset — clamp 0.1–1.0% untuk Lighter (prompt: 0.2–0.5%, beri buffer)
    if (typeof gp.limitPriceOffset === "number") {
      const clamped = Math.max(0.1, Math.min(1.0, gp.limitPriceOffset));
      if (clamped !== gp.limitPriceOffset) {
        logger.warn({ original: gp.limitPriceOffset, clamped }, "[Lighter] limitPriceOffset di luar range — diclamp");
        gp.limitPriceOffset = clamped;
      }
    }

    // [5] stopLoss — harus harga absolut < lowerPrice.
    // Jika nilainya < lowerPrice × 0.5 kemungkinan besar itu persentase/angka kecil — nullify.
    if (gp.stopLoss !== null && gp.stopLoss !== undefined) {
      if (gp.stopLoss <= 0 || gp.stopLoss >= gp.lowerPrice || gp.stopLoss < gp.lowerPrice * 0.5) {
        logger.warn({ stopLoss: gp.stopLoss, lowerPrice: gp.lowerPrice }, "[Lighter] stopLoss tidak valid sebagai harga absolut — dihapus");
        gp.stopLoss = null;
      }
    }

    // [6] takeProfit — harus harga absolut > upperPrice.
    // Jika nilainya < upperPrice kemungkinan besar itu persentase/angka kecil — nullify.
    if (gp.takeProfit !== null && gp.takeProfit !== undefined) {
      if (gp.takeProfit <= 0 || gp.takeProfit <= gp.upperPrice) {
        logger.warn({ takeProfit: gp.takeProfit, upperPrice: gp.upperPrice }, "[Lighter] takeProfit tidak valid sebagai harga absolut — dihapus");
        gp.takeProfit = null;
      }
    }
  }

  // ─── Extended Grid: Post-Process Validations ───────────────────────────────
  // Mirror Lighter validations dengan parameter per-DEX yang sesuai untuk Extended.
  if (market.exchange === "extended" && hasGrid && parsed.grid_params) {
    const gp = parsed.grid_params;
    const price = market.lastPrice;

    // [1] lowerPrice & upperPrice — resolve defaults, cek inversi
    gp.lowerPrice = gp.lowerPrice || price * 0.95;
    gp.upperPrice = gp.upperPrice || price * 1.05;
    if (gp.lowerPrice >= gp.upperPrice) {
      logger.warn({ lowerPrice: gp.lowerPrice, upperPrice: gp.upperPrice, price }, "[Extended] Grid range terbalik — swap paksa");
      [gp.lowerPrice, gp.upperPrice] = [gp.upperPrice, gp.lowerPrice];
    }

    // [2] gridLevels — clamp 2–30 untuk Extended
    const rawLevelsExt = Math.round(gp.gridLevels ?? 10);
    if (rawLevelsExt < 2 || rawLevelsExt > 30) {
      logger.warn({ original: gp.gridLevels, clamped: Math.max(2, Math.min(30, rawLevelsExt)) }, "[Extended] gridLevels di luar batas — diclamp");
    }
    gp.gridLevels = Math.max(2, Math.min(30, rawLevelsExt));

    // [3] orderType — tolak "market", paksa "post_only" (zero fee + rebates)
    if (gp.orderType === "market") {
      logger.warn({ original: "market", corrected: "post_only" }, "[Extended] orderType 'market' ditolak — paksa 'post_only'");
      gp.orderType = "post_only";
    }

    // [4] limitPriceOffset — clamp 0.05–0.5% untuk Extended (latency <10ms)
    if (typeof gp.limitPriceOffset === "number") {
      const clampedExt = Math.max(0.05, Math.min(0.5, gp.limitPriceOffset));
      if (clampedExt !== gp.limitPriceOffset) {
        logger.warn({ original: gp.limitPriceOffset, clamped: clampedExt }, "[Extended] limitPriceOffset di luar range — diclamp");
        gp.limitPriceOffset = clampedExt;
      }
    }

    // [5] stopLoss — harus harga absolut < lowerPrice, tidak lebih kecil dari lowerPrice × 0.5
    if (gp.stopLoss !== null && gp.stopLoss !== undefined) {
      if (gp.stopLoss <= 0 || gp.stopLoss >= gp.lowerPrice || gp.stopLoss < gp.lowerPrice * 0.5) {
        logger.warn({ stopLoss: gp.stopLoss, lowerPrice: gp.lowerPrice }, "[Extended] stopLoss tidak valid sebagai harga absolut — dihapus");
        gp.stopLoss = null;
      }
    }

    // [6] takeProfit — harus harga absolut > upperPrice
    if (gp.takeProfit !== null && gp.takeProfit !== undefined) {
      if (gp.takeProfit <= 0 || gp.takeProfit <= gp.upperPrice) {
        logger.warn({ takeProfit: gp.takeProfit, upperPrice: gp.upperPrice }, "[Extended] takeProfit tidak valid sebagai harga absolut — dihapus");
        gp.takeProfit = null;
      }
    }
  }


  const effectiveMinUsdc = Math.ceil(
    Math.max(market.minQuoteAmount, market.minBaseAmount * market.lastPrice) * 1.5 * 100
  ) / 100;

  const clampAmount = (raw: number | undefined, fallback: number): number =>
    Math.max(raw ?? fallback, effectiveMinUsdc);

  return {
    strategy: "grid" as const,
    grid_params: hasGrid ? {
      lowerPrice: parsed.grid_params.lowerPrice || market.lastPrice * 0.95,
      upperPrice: parsed.grid_params.upperPrice || market.lastPrice * 1.05,
      gridLevels: parsed.grid_params.gridLevels ?? 10,
      amountPerGrid: clampAmount(parsed.grid_params.amountPerGrid, 100),
      mode: parsed.grid_params.mode ?? "neutral",
      orderType: parsed.grid_params.orderType ?? "post_only",
      limitPriceOffset: parsed.grid_params.limitPriceOffset ?? (
        market.exchange === "lighter" ? 0.4 : 0.1  // extended
      ),
      stopLoss: parsed.grid_params.stopLoss ?? null,
      takeProfit: parsed.grid_params.takeProfit ?? null,
    } : null,
    reasoning: parsed.reasoning ?? "Analysis complete.",
    marketCondition: parsed.marketCondition ?? "sideways",
    riskLevel: parsed.riskLevel ?? "medium",
    volumeContext: parsed.volumeContext ?? "normal",
    confidence: parsed.confidence ?? 70,
    modelUsed,
    modelTier: tierDescription,
  };
}

// ─── Shared Market Condition Analysis ─────────────────────────────────────────
// Jalankan sekali untuk menentukan kondisi pasar, lalu hasilnya dikunci ke semua
// exchange melalui forcedMarketCondition. Ini mencegah saran plin-plan saat user
// menjalankan AI Analysis di banyak exchange pada waktu yang sama.

export interface MarketConditionResult {
  marketCondition: "bullish" | "bearish" | "sideways" | "volatile";
  confidence: number;
  reasoning: string;
  modelUsed: string;
}

const MARKET_CONDITION_SYSTEM_PROMPT = `You are a neutral market analyst. Your ONLY job is to assess the current market condition of the given asset.
Output ONLY valid JSON. No markdown, no extra text.

IMPORTANT: "reasoning" MUST be in Bahasa Indonesia (santai tapi expert).

Output format:
{
  "marketCondition": "bullish" | "bearish" | "sideways" | "volatile",
  "confidence": integer (0-100),
  "reasoning": string (Bahasa Indonesia)
}

Definitions:
- bullish: clear uptrend, higher highs/lows, buyers in control
- bearish: clear downtrend, lower highs/lows, sellers in control
- sideways: price ranging between support/resistance, no clear direction
- volatile: large erratic swings both directions, no clear trend`;

export async function analyzeMarketConditionOnly(
  symbol: string,
  lastPrice: number,
  high24h: number,
  low24h: number,
  priceChangePct24h: number,
  volume24h: number,
): Promise<MarketConditionResult> {
  const keys = loadApiKeys();
  if (keys.length === 0) throw new Error("GROQ_API_KEY tidak terkonfigurasi.");

  const range24h = high24h > 0 && low24h > 0
    ? `$${low24h.toFixed(2)} - $${high24h.toFixed(2)} (volatilitas ${(((high24h - low24h) / low24h) * 100).toFixed(1)}%)`
    : "N/A";
  const change = priceChangePct24h !== 0
    ? `${priceChangePct24h > 0 ? "+" : ""}${priceChangePct24h.toFixed(2)}%`
    : "N/A";

  const userPrompt = `Tentukan kondisi pasar untuk ${symbol}.
Harga saat ini: $${lastPrice.toFixed(4)}
Range 24h: ${range24h}
Perubahan 24h: ${change}
Volume 24h: $${volume24h.toFixed(0)}

Jawab HANYA dengan JSON sesuai format yang diminta.`;

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: MARKET_CONDITION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const { content, modelUsed } = await callWithCascade(keys, messages);

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`AI returned invalid JSON for market condition: ${content.substring(0, 200)}`);
  }

  const validConditions = ["bullish", "bearish", "sideways", "volatile"];
  const mc = validConditions.includes(parsed.marketCondition) ? parsed.marketCondition : "sideways";
  let confidence = parsed.confidence ?? 70;
  if (confidence >= 0 && confidence <= 1) confidence = Math.round(confidence * 100);

  logger.info({ symbol, marketCondition: mc, confidence, modelUsed }, "[groqAI] Shared market condition determined");

  return {
    marketCondition: mc,
    confidence,
    reasoning: parsed.reasoning ?? "",
    modelUsed,
  };
}
