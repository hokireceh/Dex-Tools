import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, TrendingUp, TrendingDown, Minus, Eye } from "lucide-react";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchAIAnalysis as fetchAiParamsShared } from "@/lib/aiAnalysis";

// ── Types ───────────────────────────────────────────────────────────────────────

interface ExtStrategy {
  id: number;
  name: string;
  type: "dca" | "grid";
  marketSymbol: string;
  isRunning: boolean;
  dcaConfig?: {
    amountPerOrder: number;
    intervalMinutes: number;
    side: "buy" | "sell";
    orderType: string;
    limitPriceOffset?: number;
  } | null;
  gridConfig?: {
    lowerPrice: number;
    upperPrice: number;
    gridLevels: number;
    amountPerGrid: number;
    mode: string;
    orderType: string;
    limitPriceOffset?: number;
    executionMode?: "aggressive" | "normal" | "passive" | null;
    maxBudgetUsd?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
  } | null;
}

interface AIResult {
  reasoning: string;
  marketCondition: "bullish" | "bearish" | "sideways" | "volatile";
  riskLevel: "low" | "medium" | "high";
  confidence: number;
  modelUsed: string;
  modelTier: string;
}

// ── Market type (untuk validasi tickSize) ───────────────────────────────────────
interface ExtMarketInfo {
  symbol: string;
  tickSize: number;
}

async function fetchExtMarketsForValidation(): Promise<ExtMarketInfo[]> {
  const res = await fetch("/api/extended/strategies/markets", { credentials: "include" });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.markets ?? []) as ExtMarketInfo[];
}

// ── Schemas ─────────────────────────────────────────────────────────────────────

const extDcaEditSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  amountPerOrder: z.coerce.number().positive("Jumlah harus positif"),
  intervalMinutes: z.coerce.number().min(1, "Interval minimal 1 menit"),
  side: z.enum(["buy", "sell"]),
  orderType: z.enum(["market", "limit", "post_only"]),
  limitPriceOffset: z.coerce.number().min(0).optional(),
});

const optionalPositiveNumber = z.preprocess(
  (val) => {
    if (val === "" || val === null || val === undefined) return undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : n;
  },
  z.number().positive("Harus angka positif").optional()
);

const extGridEditSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  lowerPrice: z.coerce.number().positive("Harga bawah harus positif"),
  upperPrice: z.coerce.number().positive("Harga atas harus positif"),
  gridLevels: z.coerce.number().min(2).max(100),
  amountPerGrid: z.coerce.number().positive("Jumlah harus positif"),
  mode: z.enum(["neutral", "long", "short"]),
  orderType: z.enum(["market", "limit", "post_only"]),
  limitPriceOffset: z.coerce.number().min(0).optional(),
  executionMode: z.enum(["aggressive", "normal", "passive"]).optional(),
  maxBudgetUsd: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().positive("Budget harus positif").optional()),
  inventorySkewEnabled: z.boolean().optional(),
  inventorySkewThreshold: z.coerce.number().min(1).max(99).optional(),
  inventorySkewMaxMult: z.coerce.number().min(1).max(10).optional(),
  inventorySkewPauseAt: z.coerce.number().min(1).max(100).optional(),
  followMarket: z.boolean().optional(),
  followMarketTriggerPct: z.coerce.number().min(0.1).max(20).optional(),
  followMarketMinIntervalMin: z.coerce.number().min(1).max(1440).optional(),
  stopLoss: optionalPositiveNumber,
  takeProfit: optionalPositiveNumber,
}).refine(d => d.upperPrice > d.lowerPrice, {
  message: "Harga atas harus lebih besar dari harga bawah",
  path: ["upperPrice"],
}).refine(d => !d.stopLoss || d.stopLoss < d.lowerPrice, {
  message: "Stop Loss harus di bawah Harga Bawah",
  path: ["stopLoss"],
}).refine(d => !d.takeProfit || d.takeProfit > d.upperPrice, {
  message: "Take Profit harus di atas Harga Atas",
  path: ["takeProfit"],
});

type ExtDcaEditData = z.infer<typeof extDcaEditSchema>;
type ExtGridEditData = z.infer<typeof extGridEditSchema>;

// ── API helpers ──────────────────────────────────────────────────────────────────

async function updateExtendedStrategy(strategyId: number, payload: object) {
  const res = await fetch(`/api/extended/strategies/${strategyId}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Gagal memperbarui strategi Extended");
  return json;
}

function sanitizeAINumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" && !isNaN(value)) return value;
  if (typeof value === "string") {
    // Try standard dot-decimal first (most AI models return this format)
    const dotParsed = parseFloat(value);
    if (!isNaN(dotParsed)) return dotParsed;
    // Fallback: European comma-decimal format ("64.956,4" → 64956.4)
    const europeanCleaned = value.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(europeanCleaned);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

const fetchAiParams = (strategyType: "dca" | "grid", marketSymbol: string) =>
  fetchAiParamsShared({ strategyType, marketSymbol, exchange: "extended" });

// ── AI Insight Card ───────────────────────────────────────────────────────────────

function AIInsightCard({ result }: { result: AIResult }) {
  const conditionIcon = {
    bullish: <TrendingUp className="w-3.5 h-3.5 text-success" />,
    bearish: <TrendingDown className="w-3.5 h-3.5 text-destructive" />,
    sideways: <Minus className="w-3.5 h-3.5 text-warning" />,
    volatile: <Sparkles className="w-3.5 h-3.5 text-primary" />,
  }[result.marketCondition];

  const riskColor = {
    low: "text-success",
    medium: "text-warning",
    high: "text-destructive",
  }[result.riskLevel];

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
          <Sparkles className="w-3.5 h-3.5" />
          Analisis AI — {result.modelTier}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {conditionIcon}
            <span className="capitalize">{result.marketCondition}</span>
          </div>
          <Badge variant="outline" className={cn("text-xs px-1.5 py-0", riskColor)}>
            {result.riskLevel === "low" ? "risiko rendah" : result.riskLevel === "medium" ? "risiko sedang" : "risiko tinggi"}
          </Badge>
          <span className="text-xs text-muted-foreground">{result.confidence}% keyakinan</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{result.reasoning}</p>
    </div>
  );
}

// ── DCA Edit Form ───────────────────────────────────────────────────────────────

function ExtDcaEditForm({
  strategy,
  onSuccess,
  onCancel,
  viewOnly,
}: {
  strategy: ExtStrategy;
  onSuccess: () => void;
  onCancel: () => void;
  viewOnly?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);
  const cfg = strategy.dcaConfig;

  const buildDcaDefaults = useCallback(() => ({
    name: strategy.name,
    amountPerOrder: cfg?.amountPerOrder ?? 100,
    intervalMinutes: cfg?.intervalMinutes ?? 1440,
    side: (cfg?.side as "buy" | "sell") ?? "buy",
    orderType: (cfg?.orderType as any) ?? "limit",
    limitPriceOffset: cfg?.limitPriceOffset ?? 0,
  }), [strategy.id]);

  const form = useForm<ExtDcaEditData>({
    resolver: zodResolver(extDcaEditSchema),
    defaultValues: buildDcaDefaults(),
  });

  useEffect(() => {
    form.reset(buildDcaDefaults());
    setAiResult(null);
  }, [strategy.id]);

  const watchOrderType = form.watch("orderType");

  const handleAIAnalyze = async () => {
    setAiLoading(true);
    setAiResult(null);
    try {
      const data = await fetchAiParams("dca", strategy.marketSymbol);
      const p = data?.dca_params;
      if (!p) throw new Error("AI tidak mengembalikan parameter DCA");
      if (p.amountPerOrder != null) form.setValue("amountPerOrder", p.amountPerOrder, { shouldValidate: true });
      if (p.intervalMinutes != null) form.setValue("intervalMinutes", p.intervalMinutes, { shouldValidate: true });
      if (p.side) form.setValue("side", p.side, { shouldValidate: true });
      if (p.orderType) form.setValue("orderType", p.orderType, { shouldValidate: true });
      if (p.limitPriceOffset != null) form.setValue("limitPriceOffset", p.limitPriceOffset, { shouldValidate: true });
      setAiResult({
        reasoning: data.reasoning,
        marketCondition: data.marketCondition,
        riskLevel: data.riskLevel,
        confidence: data.confidence,
        modelUsed: data.modelUsed,
        modelTier: data.modelTier,
      });
      toast.success("Analisis AI Selesai", { description: `Parameter diperbarui menggunakan ${data.modelTier}` });
    } catch (err: any) {
      toast.error("Analisis AI Gagal", { description: err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const onSubmit = async (data: ExtDcaEditData) => {
    setLoading(true);
    try {
      await updateExtendedStrategy(strategy.id, {
        name: data.name,
        dcaConfig: {
          amountPerOrder: data.amountPerOrder,
          intervalMinutes: data.intervalMinutes,
          side: data.side,
          orderType: data.orderType,
          limitPriceOffset:
            data.orderType === "limit" || data.orderType === "post_only"
              ? (data.limitPriceOffset ?? 0)
              : 0,
        },
      });
      toast.success("Strategi Extended Diperbarui");
      onSuccess();
    } catch (err: any) {
      toast.error("Kesalahan", { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      {viewOnly && (
        <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
          <Eye className="w-3.5 h-3.5 shrink-0" />
          <span>Bot sedang berjalan — mode lihat saja. Hentikan bot untuk mengedit.</span>
        </div>
      )}
      <fieldset disabled={viewOnly} className="border-none p-0 m-0 space-y-4">
      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300 font-mono">
        Market: {strategy.marketSymbol}
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200 hover:border-emerald-500/50 gap-2"
        onClick={handleAIAnalyze}
        disabled={aiLoading || loading}
      >
        {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {aiLoading ? "Menganalisis pasar..." : "Analisis Ulang AI & Perbarui Parameter DCA"}
      </Button>

      {aiResult && <AIInsightCard result={aiResult} />}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Jumlah (USDC)</Label>
          <Input type="text" inputMode="decimal" {...form.register("amountPerOrder")} className="bg-background font-mono" />
          {form.formState.errors.amountPerOrder && <p className="text-xs text-destructive">{form.formState.errors.amountPerOrder.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Interval (Menit)</Label>
          <Input type="text" inputMode="numeric" {...form.register("intervalMinutes")} className="bg-background font-mono" />
          {form.formState.errors.intervalMinutes && <p className="text-xs text-destructive">{form.formState.errors.intervalMinutes.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Sisi</Label>
          <Select onValueChange={(v: any) => form.setValue("side", v)} value={form.watch("side")}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="buy">Buy</SelectItem>
              <SelectItem value="sell">Sell</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tipe Order</Label>
          <Select onValueChange={(v: any) => form.setValue("orderType", v)} value={form.watch("orderType")}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="post_only">Post-Only (Maker) ⭐⭐</SelectItem>
              <SelectItem value="limit">Limit (Maker/Taker) ⭐</SelectItem>
              <SelectItem value="market">Market (Taker)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {(watchOrderType === "limit" || watchOrderType === "post_only") && (
        <div className="space-y-2">
          <Label>Limit Price Offset (%)</Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="mis. 0.4" className="bg-background font-mono" />
        </div>
      )}
      </fieldset>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        {viewOnly ? (
          <Button type="button" variant="outline" onClick={onCancel}>Tutup</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
            <Button type="submit" disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Simpan Perubahan
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

// ── Grid Edit Form ──────────────────────────────────────────────────────────────

function ExtGridEditForm({
  strategy,
  onSuccess,
  onCancel,
  viewOnly,
}: {
  strategy: ExtStrategy;
  onSuccess: () => void;
  onCancel: () => void;
  viewOnly?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);
  const cfg = strategy.gridConfig;

  // GRID-NEW-004: Fetch markets untuk validasi tickSize (di-cache oleh React Query).
  const { data: extMarkets = [] } = useQuery({
    queryKey: ["extended-markets"],
    queryFn: fetchExtMarketsForValidation,
    staleTime: 300_000,
    retry: 1,
  });

  const buildGridDefaults = useCallback(() => ({
    name: strategy.name,
    lowerPrice: cfg?.lowerPrice ?? 0,
    upperPrice: cfg?.upperPrice ?? 0,
    gridLevels: cfg?.gridLevels ?? 10,
    amountPerGrid: cfg?.amountPerGrid ?? 50,
    mode: (cfg?.mode as any) ?? "neutral",
    orderType: (cfg?.orderType as any) ?? "limit",
    limitPriceOffset: cfg?.limitPriceOffset ?? 0,
    executionMode: (cfg?.executionMode as any) ?? "normal",
    maxBudgetUsd: cfg?.maxBudgetUsd ?? undefined,
    inventorySkewEnabled: (cfg as any)?.inventorySkewEnabled ?? false,
    inventorySkewThreshold: (cfg as any)?.inventorySkewThreshold ?? undefined,
    inventorySkewMaxMult: (cfg as any)?.inventorySkewMaxMult ?? undefined,
    inventorySkewPauseAt: (cfg as any)?.inventorySkewPauseAt ?? undefined,
    followMarket: (cfg as any)?.followMarket ?? false,
    followMarketTriggerPct: (cfg as any)?.followMarketTriggerPct ?? undefined,
    followMarketMinIntervalMin: (cfg as any)?.followMarketMinIntervalMin ?? undefined,
    stopLoss: cfg?.stopLoss ?? undefined,
    takeProfit: cfg?.takeProfit ?? undefined,
  }), [strategy.id]);

  const form = useForm<ExtGridEditData>({
    resolver: zodResolver(extGridEditSchema),
    defaultValues: buildGridDefaults(),
  });

  useEffect(() => {
    form.reset(buildGridDefaults());
    setAiResult(null);
  }, [strategy.id]);

  const watchOrderType = form.watch("orderType");

  const handleAIAnalyze = async () => {
    setAiLoading(true);
    setAiResult(null);
    try {
      const data = await fetchAiParams("grid", strategy.marketSymbol);
      const p = data?.grid_params;
      if (!p) throw new Error("AI tidak mengembalikan parameter Grid");
      const lowerPrice = sanitizeAINumber(p.lowerPrice);
      const upperPrice = sanitizeAINumber(p.upperPrice);
      const gridLevels = sanitizeAINumber(p.gridLevels);
      const amountPerGrid = sanitizeAINumber(p.amountPerGrid);
      const limitPriceOffset = sanitizeAINumber(p.limitPriceOffset);
      const stopLoss = sanitizeAINumber(p.stopLoss);
      const takeProfit = sanitizeAINumber(p.takeProfit);
      if (lowerPrice != null) form.setValue("lowerPrice", lowerPrice, { shouldValidate: true });
      if (upperPrice != null) form.setValue("upperPrice", upperPrice, { shouldValidate: true });
      if (gridLevels != null) form.setValue("gridLevels", gridLevels, { shouldValidate: true });
      if (amountPerGrid != null) form.setValue("amountPerGrid", amountPerGrid, { shouldValidate: true });
      if (p.mode) form.setValue("mode", p.mode, { shouldValidate: true });
      if (p.orderType) form.setValue("orderType", p.orderType, { shouldValidate: true });
      if (limitPriceOffset != null) form.setValue("limitPriceOffset", limitPriceOffset, { shouldValidate: true });

      const aiLower: number = lowerPrice ?? form.getValues("lowerPrice") ?? 0;
      const aiUpper: number = upperPrice ?? form.getValues("upperPrice") ?? 0;

      if (stopLoss != null && aiLower > 0) {
        const isReasonable = stopLoss < aiLower && stopLoss >= aiLower * 0.5;
        if (isReasonable) {
          form.setValue("stopLoss", stopLoss, { shouldValidate: true });
        } else {
          form.setValue("stopLoss", undefined as any, { shouldValidate: false });
        }
      } else {
        form.setValue("stopLoss", undefined as any, { shouldValidate: false });
      }
      if (takeProfit != null && aiUpper > 0) {
        const isReasonable = takeProfit > aiUpper && takeProfit <= aiUpper * 2;
        if (isReasonable) {
          form.setValue("takeProfit", takeProfit, { shouldValidate: true });
        } else {
          form.setValue("takeProfit", undefined as any, { shouldValidate: false });
        }
      } else {
        form.setValue("takeProfit", undefined as any, { shouldValidate: false });
      }

      setAiResult({
        reasoning: data.reasoning,
        marketCondition: data.marketCondition,
        riskLevel: data.riskLevel,
        confidence: data.confidence,
        modelUsed: data.modelUsed,
        modelTier: data.modelTier,
      });
      toast.success("Analisis AI Selesai", { description: `Parameter grid diperbarui menggunakan ${data.modelTier}` });
    } catch (err: any) {
      toast.error("Analisis AI Gagal", { description: err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const onSubmit = async (data: ExtGridEditData) => {
    // GRID-NEW-004: Cek gridSpacing >= tickSize sebelum submit ke exchange.
    const tickSize = extMarkets.find(m => m.symbol === strategy.marketSymbol)?.tickSize;
    if (tickSize && tickSize > 0) {
      const spacing = (data.upperPrice - data.lowerPrice) / data.gridLevels;
      if (spacing < tickSize) {
        form.setError("gridLevels", {
          message: `Jarak grid (${spacing.toFixed(6)}) lebih kecil dari tickSize exchange (${tickSize})`,
        });
        return;
      }
    }
    setLoading(true);
    try {
      await updateExtendedStrategy(strategy.id, {
        name: data.name,
        gridConfig: {
          lowerPrice: data.lowerPrice,
          upperPrice: data.upperPrice,
          gridLevels: data.gridLevels,
          amountPerGrid: data.amountPerGrid,
          mode: data.mode,
          orderType: data.orderType,
          limitPriceOffset:
            data.orderType === "limit" || data.orderType === "post_only"
              ? (data.limitPriceOffset ?? 0)
              : 0,
          executionMode: data.executionMode ?? "normal",
          maxBudgetUsd: data.maxBudgetUsd || null,
          inventorySkewEnabled: data.inventorySkewEnabled || false,
          inventorySkewThreshold: data.inventorySkewThreshold ?? null,
          inventorySkewMaxMult: data.inventorySkewMaxMult ?? null,
          inventorySkewPauseAt: data.inventorySkewPauseAt ?? null,
          followMarket: data.followMarket || false,
          followMarketTriggerPct: data.followMarketTriggerPct ?? null,
          followMarketMinIntervalMin: data.followMarketMinIntervalMin ?? null,
          stopLoss: data.stopLoss || null,
          takeProfit: data.takeProfit || null,
        },
      });
      toast.success("Strategi Extended Diperbarui");
      onSuccess();
    } catch (err: any) {
      toast.error("Kesalahan", { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      {viewOnly && (
        <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
          <Eye className="w-3.5 h-3.5 shrink-0" />
          <span>Bot sedang berjalan — mode lihat saja. Hentikan bot untuk mengedit.</span>
        </div>
      )}
      <fieldset disabled={viewOnly} className="border-none p-0 m-0 space-y-4">
      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300 font-mono">
        Market: {strategy.marketSymbol}
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200 hover:border-emerald-500/50 gap-2"
        onClick={handleAIAnalyze}
        disabled={aiLoading || loading}
      >
        {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {aiLoading ? "Menganalisis pasar untuk setup grid..." : "Analisis Ulang AI & Perbarui Parameter Grid"}
      </Button>

      {aiResult && <AIInsightCard result={aiResult} />}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Harga Bawah</Label>
          <Input type="text" inputMode="decimal" {...form.register("lowerPrice")} className="bg-background font-mono" />
          {form.formState.errors.lowerPrice && <p className="text-xs text-destructive">{form.formState.errors.lowerPrice.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Harga Atas</Label>
          <Input type="text" inputMode="decimal" {...form.register("upperPrice")} className="bg-background font-mono" />
          {form.formState.errors.upperPrice && <p className="text-xs text-destructive">{form.formState.errors.upperPrice.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Level Grid</Label>
          <Input type="text" inputMode="numeric" {...form.register("gridLevels")} className="bg-background font-mono" />
          {form.formState.errors.gridLevels && <p className="text-xs text-destructive">{form.formState.errors.gridLevels.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Jumlah per Grid (USDC)</Label>
          <Input type="text" inputMode="decimal" {...form.register("amountPerGrid")} className="bg-background font-mono" />
          {form.formState.errors.amountPerGrid && <p className="text-xs text-destructive">{form.formState.errors.amountPerGrid.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Mode</Label>
          <Select onValueChange={(v: any) => form.setValue("mode", v)} value={form.watch("mode")}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="neutral">Netral (Beli &amp; Jual)</SelectItem>
              <SelectItem value="long">Long (Beli saja)</SelectItem>
              <SelectItem value="short">Short (Jual saja)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tipe Order</Label>
          <Select onValueChange={(v: any) => form.setValue("orderType", v)} value={form.watch("orderType")}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="post_only">Post-Only (Maker) ⭐⭐</SelectItem>
              <SelectItem value="limit">Limit (Maker/Taker) ⭐</SelectItem>
              <SelectItem value="market">Market (Taker)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {(watchOrderType === "limit" || watchOrderType === "post_only") && (
        <div className="space-y-2">
          <Label>Limit Price Offset (%)</Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="mis. 0.4" className="bg-background font-mono" />
        </div>
      )}

      <div className="space-y-2">
        <Label>Mode Eksekusi</Label>
        <Select
          onValueChange={(v: any) => form.setValue("executionMode", v)}
          value={form.watch("executionMode") || "normal"}
        >
          <SelectTrigger className="bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="aggressive">Agresif — spread 0.5× (lebih banyak fill)</SelectItem>
            <SelectItem value="normal">Normal — spread standar (default)</SelectItem>
            <SelectItem value="passive">Pasif — spread 1.5× (lebih sedikit fill, jaminan maker fee)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Budget Maksimum (USD) <span className="text-xs text-muted-foreground">(opsional)</span></Label>
        <Input type="text" inputMode="decimal" {...form.register("maxBudgetUsd")} placeholder="mis. 50 (kosong = unlimited)" className="bg-background font-mono" />
        <p className="text-xs text-muted-foreground">Bot berhenti otomatis jika total fee yang dibayar mencapai batas ini.</p>
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="extEditSkewEnabled" {...form.register("inventorySkewEnabled")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="extEditSkewEnabled" className="text-sm font-medium cursor-pointer">Inventory Skew Management <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
            <p className="text-xs text-muted-foreground">Memperlebar spread di sisi berat agar inventory otomatis rebalance.</p>
          </div>
        </div>
        {form.watch("inventorySkewEnabled") && (
          <div className="grid grid-cols-3 gap-3 pl-7">
            <div className="space-y-1">
              <Label className="text-xs">Threshold (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewThreshold")} placeholder="20" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Skew aktif di atas nilai ini</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Multiplier</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewMaxMult")} placeholder="2.0" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Maks perlebaran spread</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pause At (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewPauseAt")} placeholder="kosong = tidak pause" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Tahan sisi ini jika skew ekstrem</p>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="extEditFollowMarket" {...form.register("followMarket")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="extEditFollowMarket" className="text-sm font-medium cursor-pointer">Follow Market Grid <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
            <p className="text-xs text-muted-foreground">Grid center bergerak otomatis mengikuti harga pasar.</p>
          </div>
        </div>
        {form.watch("followMarket") && (
          <div className="grid grid-cols-2 gap-3 pl-7">
            <div className="space-y-1">
              <Label className="text-xs">Trigger (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("followMarketTriggerPct")} placeholder="1.0" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">% pergerakan dari center → re-anchor</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Min Interval (menit)</Label>
              <Input type="text" inputMode="decimal" {...form.register("followMarketMinIntervalMin")} placeholder="5" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Jeda minimum antar re-anchor</p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-muted-foreground">Stop Loss (opsional)</Label>
          <Input type="text" inputMode="decimal" {...form.register("stopLoss")} placeholder="mis. 1700" className="bg-background font-mono" />
          {form.formState.errors.stopLoss && <p className="text-xs text-destructive">{form.formState.errors.stopLoss.message}</p>}
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">Take Profit (opsional)</Label>
          <Input type="text" inputMode="decimal" {...form.register("takeProfit")} placeholder="mis. 2400" className="bg-background font-mono" />
          {form.formState.errors.takeProfit && <p className="text-xs text-destructive">{form.formState.errors.takeProfit.message}</p>}
        </div>
      </div>

      </fieldset>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        {viewOnly ? (
          <Button type="button" variant="outline" onClick={onCancel}>Tutup</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
            <Button type="submit" disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Simpan Perubahan
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

// ── Modal utama ─────────────────────────────────────────────────────────────────

export function ExtEditStrategyModal({
  strategy,
  onClose,
  viewOnly,
}: {
  strategy: ExtStrategy | null;
  onClose: () => void;
  viewOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(!!strategy);
  }, [strategy]);

  if (!strategy) return null;

  const handleClose = () => {
    setOpen(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-[580px] bg-card border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExchangeLogo exchange="extended" size={20} />
            {viewOnly ? <Eye className="w-5 h-5 text-amber-400" /> : null}
            {viewOnly ? "Lihat Strategi" : "Edit Strategi"} — {strategy.name}
          </DialogTitle>
        </DialogHeader>

        {strategy.type === "dca" ? (
          <ExtDcaEditForm strategy={strategy} onSuccess={handleClose} onCancel={handleClose} viewOnly={viewOnly} />
        ) : (
          <ExtGridEditForm strategy={strategy} onSuccess={handleClose} onCancel={handleClose} viewOnly={viewOnly} />
        )}
      </DialogContent>
    </Dialog>
  );
}
