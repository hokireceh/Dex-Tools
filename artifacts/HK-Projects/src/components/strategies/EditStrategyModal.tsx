import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useUpdateStrategy, useGetOrderBooks, getGetStrategiesQueryKey } from "@workspace/api-client-react";
import { Loader2, Sparkles, TrendingUp, TrendingDown, Minus, Eye } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { fetchAIAnalysis } from "@/lib/aiAnalysis";

const dcaEditSchema = z.object({
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
  z.number().positive("Must be a positive number").optional()
);

const gridEditSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  lowerPrice: z.coerce.number().positive("Harga bawah harus positif"),
  upperPrice: z.coerce.number().positive("Harga atas harus positif"),
  gridLevels: z.coerce.number().min(3, "Minimal 3 level").max(20, "Maksimal 20 level"),
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
}).refine(data => data.upperPrice > data.lowerPrice, {
  message: "Harga atas harus lebih besar dari harga bawah",
  path: ["upperPrice"],
}).refine(data => !data.stopLoss || data.stopLoss < data.lowerPrice, {
  message: "Stop Loss harus di bawah Harga Bawah (agar bot tidak langsung berhenti)",
  path: ["stopLoss"],
}).refine(data => !data.takeProfit || data.takeProfit > data.upperPrice, {
  message: "Take Profit harus di atas Harga Atas (agar bot tidak langsung berhenti)",
  path: ["takeProfit"],
});

type DcaEditData = z.infer<typeof dcaEditSchema>;
type GridEditData = z.infer<typeof gridEditSchema>;

interface Strategy {
  id: number;
  name: string;
  type: string;
  marketIndex?: number;
  marketSymbol: string;
  isRunning: boolean;
  dcaConfig?: any;
  gridConfig?: any;
}

interface EditStrategyModalProps {
  strategy: Strategy | null;
  onClose: () => void;
  viewOnly?: boolean;
}

interface AIResult {
  reasoning: string;
  marketCondition: "bullish" | "bearish" | "sideways" | "volatile";
  riskLevel: "low" | "medium" | "high";
  confidence: number;
  modelUsed: string;
  modelTier: string;
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
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
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


function DcaEditForm({ strategy, onClose, viewOnly }: { strategy: Strategy; onClose: () => void; viewOnly?: boolean }) {
  const queryClient = useQueryClient();
  const cfg = strategy.dcaConfig ?? {};
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);

  const form = useForm<DcaEditData>({
    resolver: zodResolver(dcaEditSchema),
    defaultValues: {
      name: strategy.name,
      amountPerOrder: cfg.amountPerOrder ?? "",
      intervalMinutes: cfg.intervalMinutes ?? "",
      side: cfg.side ?? "buy",
      orderType: cfg.orderType ?? "market",
      limitPriceOffset: cfg.limitPriceOffset ?? 0,
    },
  });

  const watchOrderType = form.watch("orderType");
  const watchSide = form.watch("side");

  const updateMutation = useUpdateStrategy({
    mutation: {
      onSuccess: () => {
        toast.success("Strategi Diperbarui", { description: "Perubahan berhasil disimpan." });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        toast.error("Kesalahan", { description: err.message || "Gagal memperbarui strategi" });
      },
    },
  });

  const handleAIAnalyze = async () => {
    const marketIndex = strategy.marketIndex;
    if (marketIndex === undefined || marketIndex === null) {
      toast.error("Indeks pasar tidak tersedia");
      return;
    }
    setAiLoading(true);
    setAiResult(null);
    try {
      const data = await fetchAIAnalysis({ strategyType: "dca", marketIndex });
      const rec = data.dca_params;
      if (!rec) throw new Error("AI tidak mengembalikan parameter DCA");
      const amountPerOrder = sanitizeAINumber(rec.amountPerOrder);
      const intervalMinutes = sanitizeAINumber(rec.intervalMinutes);
      if (amountPerOrder) form.setValue("amountPerOrder", amountPerOrder);
      if (intervalMinutes) form.setValue("intervalMinutes", intervalMinutes);
      if (rec.side) form.setValue("side", rec.side);
      if (rec.orderType) form.setValue("orderType", rec.orderType);
      if (rec.limitPriceOffset !== undefined) form.setValue("limitPriceOffset", rec.limitPriceOffset);
      setAiResult({ reasoning: data.reasoning, marketCondition: data.marketCondition, riskLevel: data.riskLevel, confidence: data.confidence, modelUsed: data.modelUsed, modelTier: data.modelTier });
      toast.success("Analisis AI Selesai", { description: `Parameter diperbarui menggunakan ${data.modelTier}` });
    } catch (err: any) {
      toast.error("Analisis AI Gagal", { description: err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const onSubmit = (data: DcaEditData) => {
    updateMutation.mutate({
      id: strategy.id,
      data: {
        name: data.name,
        dcaConfig: {
          amountPerOrder: data.amountPerOrder,
          intervalMinutes: data.intervalMinutes,
          side: data.side,
          orderType: data.orderType,
          limitPriceOffset: (data.orderType === "limit" || data.orderType === "post_only") ? (data.limitPriceOffset ?? 0) : 0,
        },
      },
    });
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
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

      <Button
        type="button"
        variant="outline"
        className="w-full border-primary/40 text-primary hover:bg-primary/10 gap-2"
        onClick={handleAIAnalyze}
        disabled={aiLoading}
      >
        {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {aiLoading ? "Menganalisis pasar..." : "Analisis Ulang AI & Perbarui Parameter"}
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
          <Select value={watchSide} onValueChange={(v: any) => form.setValue("side", v)}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="buy">Buy</SelectItem>
              <SelectItem value="sell">Sell</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tipe Order</Label>
          <Select value={watchOrderType} onValueChange={(v: any) => form.setValue("orderType", v)}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="post_only">Post-Only (Maker Only) ⭐⭐</SelectItem>
              <SelectItem value="limit">Limit (Maker/Taker) ⭐</SelectItem>
              <SelectItem value="market">Market (Taker)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {(watchOrderType === "limit" || watchOrderType === "post_only") && (
        <div className="space-y-2">
          <Label>
            Limit Price Offset (%)
            <span className="ml-1.5 text-xs text-muted-foreground">— offset dari harga pasar</span>
          </Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="mis. 0.4" className="bg-background font-mono" />
          <p className="text-xs text-muted-foreground">
            Beli: order di <strong>bawah</strong> harga pasar. Jual: di <strong>atas</strong>. (0.4 = 0.4% dari harga)
          </p>
        </div>
      )}

      </fieldset>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        {viewOnly ? (
          <Button type="button" variant="outline" onClick={onClose}>Tutup</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Simpan Perubahan
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

function GridEditForm({ strategy, onClose, viewOnly }: { strategy: Strategy; onClose: () => void; viewOnly?: boolean }) {
  const queryClient = useQueryClient();
  const cfg = strategy.gridConfig ?? {};
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [gridSizeError, setGridSizeError] = useState<string | null>(null);

  const { data: marketsData } = useGetOrderBooks();
  const markets = marketsData?.markets ?? [];

  const form = useForm<GridEditData>({
    resolver: zodResolver(gridEditSchema),
    defaultValues: {
      name: strategy.name,
      lowerPrice: cfg.lowerPrice ?? "",
      upperPrice: cfg.upperPrice ?? "",
      gridLevels: cfg.gridLevels ?? "",
      amountPerGrid: cfg.amountPerGrid ?? "",
      mode: cfg.mode ?? "neutral",
      orderType: cfg.orderType ?? "post_only",
      limitPriceOffset: cfg.limitPriceOffset ?? 0.4,
      executionMode: (cfg as any).executionMode ?? "normal",
      maxBudgetUsd: (cfg as any).maxBudgetUsd ?? undefined,
      inventorySkewEnabled: (cfg as any).inventorySkewEnabled ?? false,
      inventorySkewThreshold: (cfg as any).inventorySkewThreshold ?? undefined,
      inventorySkewMaxMult: (cfg as any).inventorySkewMaxMult ?? undefined,
      inventorySkewPauseAt: (cfg as any).inventorySkewPauseAt ?? undefined,
      followMarket: (cfg as any).followMarket ?? false,
      followMarketTriggerPct: (cfg as any).followMarketTriggerPct ?? undefined,
      followMarketMinIntervalMin: (cfg as any).followMarketMinIntervalMin ?? undefined,
      stopLoss: cfg.stopLoss ?? undefined,
      takeProfit: cfg.takeProfit ?? undefined,
    },
  });

  const watchOrderType = form.watch("orderType");
  const watchMode = form.watch("mode");
  const watchAmountPerGrid = form.watch("amountPerGrid");

  useEffect(() => {
    if (strategy.marketIndex === undefined || strategy.marketIndex === null) return;
    let cancelled = false;
    fetch(`/api/market/ticker/${strategy.marketIndex}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data?.lastPrice > 0) setCurrentPrice(data.lastPrice);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [strategy.marketIndex]);

  useEffect(() => {
    const market = markets.find(m => m.index === strategy.marketIndex);
    const amount = Number(watchAmountPerGrid);
    if (!market || !currentPrice || currentPrice <= 0 || !(amount > 0)) {
      setGridSizeError(null);
      return;
    }
    const minBase = market.minBaseAmount ?? 0;
    if (minBase > 0) {
      const estimatedSize = amount / currentPrice;
      if (estimatedSize < minBase) {
        const minUSD = Math.ceil(minBase * currentPrice * 1.2 * 100) / 100;
        setGridSizeError(`Jumlah per grid terlalu kecil — minimum ${minBase} ${market.baseAsset ?? ""} (sekitar $${minUSD})`);
        return;
      }
    }
    setGridSizeError(null);
  }, [watchAmountPerGrid, currentPrice, markets, strategy.marketIndex]);

  const updateMutation = useUpdateStrategy({
    mutation: {
      onSuccess: () => {
        toast.success("Strategi Diperbarui", { description: "Perubahan berhasil disimpan." });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        toast.error("Kesalahan", { description: err.message || "Gagal memperbarui strategi" });
      },
    },
  });

  const handleAIAnalyze = async () => {
    const marketIndex = strategy.marketIndex;
    if (marketIndex === undefined || marketIndex === null) {
      toast.error("Indeks pasar tidak tersedia");
      return;
    }
    setAiLoading(true);
    setAiResult(null);
    try {
      const data = await fetchAIAnalysis({ strategyType: "grid", marketIndex });
      const rec = data.grid_params;
      if (!rec) throw new Error("AI tidak mengembalikan parameter Grid");
      const lowerPrice = sanitizeAINumber(rec.lowerPrice);
      const upperPrice = sanitizeAINumber(rec.upperPrice);
      const gridLevels = sanitizeAINumber(rec.gridLevels);
      const amountPerGrid = sanitizeAINumber(rec.amountPerGrid);
      const limitPriceOffset = sanitizeAINumber(rec.limitPriceOffset);
      const stopLoss = sanitizeAINumber(rec.stopLoss);
      const takeProfit = sanitizeAINumber(rec.takeProfit);
      if (lowerPrice != null) form.setValue("lowerPrice", lowerPrice, { shouldValidate: true });
      if (upperPrice != null) form.setValue("upperPrice", upperPrice, { shouldValidate: true });
      if (gridLevels != null) form.setValue("gridLevels", gridLevels, { shouldValidate: true });
      if (amountPerGrid != null) form.setValue("amountPerGrid", amountPerGrid, { shouldValidate: true });
      if (rec.mode) form.setValue("mode", rec.mode, { shouldValidate: true });
      if (rec.orderType) form.setValue("orderType", rec.orderType, { shouldValidate: true });
      if (limitPriceOffset !== undefined) form.setValue("limitPriceOffset", limitPriceOffset, { shouldValidate: true });
      const aiLower = lowerPrice ?? form.getValues("lowerPrice") ?? 0;
      const aiUpper = upperPrice ?? form.getValues("upperPrice") ?? 0;
      if (stopLoss != null && aiLower > 0) {
        const isReasonable = stopLoss < aiLower && stopLoss >= aiLower * 0.5;
        if (isReasonable) form.setValue("stopLoss", stopLoss, { shouldValidate: true });
        else form.setValue("stopLoss", undefined as any, { shouldValidate: false });
      } else {
        form.setValue("stopLoss", undefined as any, { shouldValidate: false });
      }
      if (takeProfit != null && aiUpper > 0) {
        const isReasonable = takeProfit > aiUpper && takeProfit <= aiUpper * 2;
        if (isReasonable) form.setValue("takeProfit", takeProfit, { shouldValidate: true });
        else form.setValue("takeProfit", undefined as any, { shouldValidate: false });
      } else {
        form.setValue("takeProfit", undefined as any, { shouldValidate: false });
      }
      setAiResult({ reasoning: data.reasoning, marketCondition: data.marketCondition, riskLevel: data.riskLevel, confidence: data.confidence, modelUsed: data.modelUsed, modelTier: data.modelTier });
      toast.success("Analisis AI Selesai", { description: `Parameter grid diperbarui menggunakan ${data.modelTier}` });
    } catch (err: any) {
      toast.error("Analisis AI Gagal", { description: err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const onSubmit = (data: GridEditData) => {
    if (gridSizeError) return;
    updateMutation.mutate({
      id: strategy.id,
      data: {
        name: data.name,
        gridConfig: {
          lowerPrice: data.lowerPrice,
          upperPrice: data.upperPrice,
          gridLevels: data.gridLevels,
          amountPerGrid: data.amountPerGrid,
          mode: data.mode,
          orderType: data.orderType,
          limitPriceOffset: (data.orderType === "limit" || data.orderType === "post_only") ? (data.limitPriceOffset ?? 0) : 0,
          executionMode: (data as any).executionMode ?? "normal",
          maxBudgetUsd: (data as any).maxBudgetUsd || null,
          inventorySkewEnabled: (data as any).inventorySkewEnabled || false,
          inventorySkewThreshold: (data as any).inventorySkewThreshold ?? null,
          inventorySkewMaxMult: (data as any).inventorySkewMaxMult ?? null,
          inventorySkewPauseAt: (data as any).inventorySkewPauseAt ?? null,
          followMarket: (data as any).followMarket || false,
          followMarketTriggerPct: (data as any).followMarketTriggerPct ?? null,
          followMarketMinIntervalMin: (data as any).followMarketMinIntervalMin ?? null,
          stopLoss: data.stopLoss || null,
          takeProfit: data.takeProfit || null,
        },
      },
    });
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
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

      <Button
        type="button"
        variant="outline"
        className="w-full border-primary/40 text-primary hover:bg-primary/10 gap-2"
        onClick={handleAIAnalyze}
        disabled={aiLoading}
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
          {!form.formState.errors.amountPerGrid && gridSizeError && <p className="text-xs text-destructive">{gridSizeError}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Mode</Label>
          <Select value={watchMode} onValueChange={(v: any) => form.setValue("mode", v)}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="neutral">Netral (Keduanya)</SelectItem>
              <SelectItem value="long">Long (Beli saja)</SelectItem>
              <SelectItem value="short">Short (Jual saja)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tipe Order</Label>
          <Select value={watchOrderType} onValueChange={(v: any) => form.setValue("orderType", v)}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="post_only">Post-Only (Maker Only) ⭐⭐</SelectItem>
              <SelectItem value="limit">Limit (Maker/Taker) ⭐</SelectItem>
            </SelectContent>
          </Select>
          {watchOrderType === "post_only" && (
            <p className="text-xs text-muted-foreground">Ditolak exchange jika langsung match — jaminan maker only, tidak ada taker fee.</p>
          )}
        </div>
      </div>

      {(watchOrderType === "limit" || watchOrderType === "post_only") && (
        <div className="space-y-2">
          <Label>
            Limit Price Offset (%)
            <span className="ml-1.5 text-xs text-muted-foreground">— offset dari harga pasar saat eksekusi</span>
          </Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="mis. 0.4" className="bg-background font-mono" />
          <p className="text-xs text-muted-foreground">
            Buy: order di <strong>bawah</strong> harga pasar. Sell: di <strong>atas</strong> harga pasar. (0.4 = 0.4% dari harga)
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>Mode Eksekusi</Label>
        <Select onValueChange={(v: any) => form.setValue("executionMode" as any, v)} value={(form.watch("executionMode" as any) as string) || "normal"}>
          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="aggressive">Agresif — spread 0.5× (lebih banyak fill, fee taker lebih mungkin)</SelectItem>
            <SelectItem value="normal">Normal — spread 1× (default)</SelectItem>
            <SelectItem value="passive">Pasif — spread 1.5× + post-only (lebih sedikit fill, jaminan maker fee)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Mengatur lebar spread dari Limit Price Offset. Pasif juga mengaktifkan Post-Only.</p>
      </div>

      <div className="space-y-2">
        <Label>Budget Maksimum (USD) <span className="text-xs text-muted-foreground">(opsional)</span></Label>
        <Input type="text" inputMode="decimal" {...form.register("maxBudgetUsd" as any)} placeholder="mis. 50 (kosong = unlimited)" className="bg-background font-mono" />
        <p className="text-xs text-muted-foreground">Bot berhenti otomatis jika total fee yang dibayar mencapai batas ini.</p>
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="lighterEditSkewEnabled" {...form.register("inventorySkewEnabled" as any)} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="lighterEditSkewEnabled" className="text-sm font-medium cursor-pointer">Inventory Skew Management <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
            <p className="text-xs text-muted-foreground">Memperlebar spread di sisi berat agar inventory otomatis rebalance.</p>
          </div>
        </div>
        {form.watch("inventorySkewEnabled" as any) && (
          <div className="grid grid-cols-3 gap-3 pl-7">
            <div className="space-y-1">
              <Label className="text-xs">Threshold (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewThreshold" as any)} placeholder="20" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Skew aktif di atas nilai ini</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Multiplier</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewMaxMult" as any)} placeholder="2.0" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Maks perlebaran spread</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pause At (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("inventorySkewPauseAt" as any)} placeholder="kosong = tidak pause" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Tahan sisi ini jika skew ekstrem</p>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="lighterEditFollowMarket" {...form.register("followMarket" as any)} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="lighterEditFollowMarket" className="text-sm font-medium cursor-pointer">Follow Market Grid <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
            <p className="text-xs text-muted-foreground">Grid center bergerak otomatis mengikuti harga pasar.</p>
          </div>
        </div>
        {form.watch("followMarket" as any) && (
          <div className="grid grid-cols-2 gap-3 pl-7">
            <div className="space-y-1">
              <Label className="text-xs">Trigger (%)</Label>
              <Input type="text" inputMode="decimal" {...form.register("followMarketTriggerPct" as any)} placeholder="1.0" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">% pergerakan dari center → re-anchor</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Min Interval (menit)</Label>
              <Input type="text" inputMode="decimal" {...form.register("followMarketMinIntervalMin" as any)} placeholder="5" className="bg-background font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Jeda minimum antar re-anchor</p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Stop Loss <span className="text-xs text-muted-foreground">(opsional)</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("stopLoss")} placeholder="mis. 1700" className="bg-background font-mono" />
          <p className="text-xs text-muted-foreground">Bot berhenti jika harga turun di bawah ini</p>
        </div>
        <div className="space-y-2">
          <Label>Take Profit <span className="text-xs text-muted-foreground">(opsional)</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("takeProfit")} placeholder="mis. 2500" className="bg-background font-mono" />
          <p className="text-xs text-muted-foreground">Bot berhenti jika harga naik di atas ini</p>
        </div>
      </div>

      </fieldset>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        {viewOnly ? (
          <Button type="button" variant="outline" onClick={onClose}>Tutup</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Simpan Perubahan
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

export function EditStrategyModal({ strategy, onClose, viewOnly }: EditStrategyModalProps) {
  return (
    <Dialog open={!!strategy} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto bg-card border-border shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            {viewOnly ? <Eye className="w-5 h-5 text-amber-400" /> : null}
            {viewOnly ? "Lihat Strategi" : "Edit Strategi"}
            {strategy && (
              <span className="text-sm font-normal text-muted-foreground">
                — {strategy.marketSymbol} {strategy.type.toUpperCase()}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {strategy?.type === "dca" && (
          <DcaEditForm strategy={strategy} onClose={onClose} viewOnly={viewOnly} />
        )}
        {strategy?.type === "grid" && (
          <GridEditForm strategy={strategy} onClose={onClose} viewOnly={viewOnly} />
        )}
      </DialogContent>
    </Dialog>
  );
}
