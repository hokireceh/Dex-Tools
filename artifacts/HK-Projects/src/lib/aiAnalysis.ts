type MarketCondition = "bullish" | "bearish" | "sideways" | "volatile";
type StrategyType = "dca" | "grid";
type Exchange = "lighter" | "extended";

interface FetchAIParams {
  strategyType: StrategyType;
  marketIndex?: number;
  marketSymbol?: string;
  exchange?: Exchange;
}

async function fetchSharedMarketCondition(params: {
  marketIndex?: number;
  marketSymbol?: string;
  exchange?: Exchange;
}): Promise<MarketCondition | null> {
  try {
    const res = await fetch("/api/ai/analyze/market-condition", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.marketCondition ?? null;
  } catch {
    return null;
  }
}

export async function fetchAIAnalysis(params: FetchAIParams): Promise<any> {
  const forcedMarketCondition = await fetchSharedMarketCondition({
    marketIndex: params.marketIndex,
    marketSymbol: params.marketSymbol,
    exchange: params.exchange,
  });

  const res = await fetch("/api/ai/analyze", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: params.strategyType,
      marketIndex: params.marketIndex,
      marketSymbol: params.marketSymbol,
      exchange: params.exchange,
      forcedMarketCondition,
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "AI request failed");
  return json;
}
