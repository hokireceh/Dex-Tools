import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useCreateStrategy, useGetOrderBooks } from "@workspace/api-client-react";
import { Plus, Loader2, ChevronsUpDown, Check, Sparkles, TrendingUp, TrendingDown, Minus, Percent } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { fetchAIAnalysis } from "@/lib/aiAnalysis";

const optionalPositiveNumber = z.preprocess(
  (val) => {
    if (val === "" || val === null || val === undefined) return undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : n;
  },
  z.number().positive("Must be a positive number").optional()
);

const gridSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  marketIndex: z.coerce.number({ required_error: "Pilih pasar terlebih dahulu" }),
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

type GridFormData = z.infer<typeof gridSchema>;

interface MarketPickerProps {
  selectedMarket: { index: number; label: string } | null;
  onSelect: (m: { index: number; label: string }) => void;
  error?: string;
  markets: Array<{ index: number; symbol: string; type: string }>;
}

function MarketPicker({ selectedMarket, onSelect, error, markets }: MarketPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Label>Market</Label>
      <Popover open={open} onOpenChange={setOpen} modal={true}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between bg-background font-normal"
          >
            {selectedMarket ? (
              <span className="font-mono text-sm">{selectedMarket.label}</span>
            ) : (
              <span className="text-muted-foreground">Cari pasar (mis. BTC, ETH)...</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0 z-[200]" align="start">
          <Command>
            <CommandInput placeholder="Cari pasar..." />
            <CommandList className="max-h-[240px] overflow-y-auto">
              <CommandEmpty>Pasar tidak ditemukan.</CommandEmpty>
              <CommandGroup>
                {markets.map(m => {
                  const label = `${m.symbol} (${m.type})`;
                  return (
                    <CommandItem
                      key={m.index}
                      value={label}
                      onSelect={() => {
                        onSelect({ index: m.index, label });
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn("mr-2 h-4 w-4", selectedMarket?.index === m.index ? "opacity-100" : "opacity-0")}
                      />
                      <span className="font-mono text-sm">{m.symbol}</span>
                      <span className="ml-2 text-xs text-muted-foreground capitalize">{m.type}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

interface AIResult {
  reasoning: string;
  marketCondition: "bullish" | "bearish" | "sideways" | "volatile";
  riskLevel: "low" | "medium" | "high";
  confidence: number;
  modelUsed: string;
  modelTier: string;
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
      <div className="flex items-center justify-between">
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

// Sanitize numbers from AI — guard against European locale format (comma decimal separator).
// JS JSON.parse normally enforces dot-decimal, but some models occasionally produce
// string fields. This ensures we always store a clean JS number.
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


// ── Lighter FR Arb Form ───────────────────────────────────────────────────────

const frArbSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  marketIndex: z.coerce.number({ required_error: "Pilih pasar terlebih dahulu" }),
  side: z.enum(["auto", "long", "short"]),
  positionSize: z.coerce.number().positive("Size harus positif"),
  entryFrThreshold: z.coerce.number().positive("Entry threshold harus positif"),
  exitFrThreshold: z.coerce.number().positive("Exit threshold harus positif"),
  maxHoldHours: z.coerce.number().min(1, "Minimal 1 jam").max(720, "Maksimal 720 jam"),
  orderType: z.enum(["market", "limit", "post_only"]),
  limitPriceOffset: z.coerce.number().min(0).optional(),
  stopLoss: optionalPositiveNumber,
}).refine(data => data.exitFrThreshold < data.entryFrThreshold, {
  message: "Exit threshold harus lebih kecil dari Entry threshold",
  path: ["exitFrThreshold"],
});

type FrArbFormData = z.infer<typeof frArbSchema>;

interface FrArbFormProps {
  markets: Array<{ index: number; symbol: string; type: string }>;
  onSuccess: () => void;
  onCancel: () => void;
}

function LighterFrArbForm({ markets, onSuccess, onCancel }: FrArbFormProps) {
  const [selectedMarket, setSelectedMarket] = useState<{ index: number; label: string } | null>(null);

  const perpMarkets = markets.filter(m => m.type === "perp");

  const form = useForm<FrArbFormData>({
    resolver: zodResolver(frArbSchema),
    defaultValues: {
      side: "auto",
      positionSize: 100,
      entryFrThreshold: 0.05,
      exitFrThreshold: 0.01,
      maxHoldHours: 24,
      orderType: "market",
    },
  });

  const watchOrderType = form.watch("orderType");

  const createMutation = useCreateStrategy({
    mutation: {
      onSuccess: () => {
        toast.success("Strategi Dibuat", { description: "Bot FR Arb Lighter kamu siap." });
        onSuccess();
      },
      onError: (err: any) => {
        toast.error("Kesalahan", { description: err.message || "Gagal membuat strategi" });
      },
    },
  });

  const onSubmit = (data: FrArbFormData) => {
    createMutation.mutate({
      data: {
        name: data.name,
        type: "funding_arb",
        marketIndex: data.marketIndex,
        frArbConfig: {
          positionSize: data.positionSize,
          entryFrThreshold: data.entryFrThreshold / 100,
          exitFrThreshold: data.exitFrThreshold / 100,
          maxHoldHours: data.maxHoldHours,
          side: data.side,
          orderType: data.orderType,
          limitPriceOffset: (data.orderType === "limit" || data.orderType === "post_only") ? (data.limitPriceOffset ?? 0) : null,
          stopLoss: data.stopLoss ?? null,
        },
      },
    });
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      <div className="p-3 rounded-lg bg-teal-500/5 border border-teal-500/20 text-xs text-muted-foreground">
        Bot masuk posisi jika |FR| ≥ <strong>Entry Threshold</strong>, dan keluar jika
        |FR| ≤ <strong>Exit Threshold</strong> atau durasi melebihi <strong>Max Hold</strong>.
        Polling setiap <strong>15 menit</strong>.
      </div>

      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} placeholder="mis. BTC FR Arb Lighter" className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <MarketPicker
        markets={perpMarkets}
        selectedMarket={selectedMarket}
        onSelect={(m) => { setSelectedMarket(m); form.setValue("marketIndex", m.index, { shouldValidate: true }); }}
        error={form.formState.errors.marketIndex?.message}
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Sisi Posisi</Label>
          <Select onValueChange={(v: any) => form.setValue("side", v)} value={form.watch("side") || "auto"}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto"><span className="text-teal-400 font-bold">AUTO</span> — ikuti sinyal FR</SelectItem>
              <SelectItem value="long"><span className="text-green-400 font-bold">LONG</span> — FR negatif</SelectItem>
              <SelectItem value="short"><span className="text-red-400 font-bold">SHORT</span> — FR positif</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">AUTO: short jika FR &gt; 0, long jika FR &lt; 0.</p>
        </div>
        <div className="space-y-2">
          <Label>Size (USDC)</Label>
          <Input type="text" inputMode="decimal" {...form.register("positionSize")} placeholder="100" className="bg-background font-mono" />
          {form.formState.errors.positionSize && <p className="text-xs text-destructive">{form.formState.errors.positionSize.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Entry Threshold (%/jam) <span className="ml-1 text-[10px] text-muted-foreground">masuk jika |FR| ≥</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("entryFrThreshold")} placeholder="0.05" className="bg-background font-mono" />
          {form.formState.errors.entryFrThreshold && <p className="text-xs text-destructive">{form.formState.errors.entryFrThreshold.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Exit Threshold (%/jam) <span className="ml-1 text-[10px] text-muted-foreground">keluar jika |FR| ≤</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("exitFrThreshold")} placeholder="0.01" className="bg-background font-mono" />
          {form.formState.errors.exitFrThreshold && <p className="text-xs text-destructive">{form.formState.errors.exitFrThreshold.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Max Hold (jam) <span className="ml-1 text-[10px] text-muted-foreground">force close setelah</span></Label>
          <Input type="text" inputMode="numeric" {...form.register("maxHoldHours")} placeholder="24" className="bg-background font-mono" />
          {form.formState.errors.maxHoldHours && <p className="text-xs text-destructive">{form.formState.errors.maxHoldHours.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Tipe Order</Label>
          <Select onValueChange={(v: any) => form.setValue("orderType", v)} value={watchOrderType || "market"}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="market">Market</SelectItem>
              <SelectItem value="limit">Limit</SelectItem>
              <SelectItem value="post_only">Post-Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {(watchOrderType === "limit" || watchOrderType === "post_only") && (
        <div className="space-y-2">
          <Label>Limit Price Offset (%) <span className="ml-1 text-xs text-muted-foreground">— offset dari harga pasar</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="0.2" className="bg-background font-mono" />
          {form.formState.errors.limitPriceOffset && <p className="text-xs text-destructive">{form.formState.errors.limitPriceOffset.message}</p>}
        </div>
      )}

      <div className="space-y-2">
        <Label>Stop Loss <span className="text-xs text-muted-foreground">(opsional)</span></Label>
        <Input type="text" inputMode="decimal" {...form.register("stopLoss")} placeholder="mis. 28000" className="bg-background font-mono" />
        <p className="text-xs text-muted-foreground">Bot close posisi jika harga menyentuh nilai ini</p>
      </div>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={createMutation.isPending} className="bg-teal-600 hover:bg-teal-700 text-white">
          {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Buat Bot FR Arb
        </Button>
      </div>
    </form>
  );
}

interface GridFormProps {
  markets: Array<{ index: number; symbol: string; type: string; minBaseAmount?: number; minQuoteAmount?: number; baseAsset?: string }>;
  onSuccess: () => void;
  onCancel: () => void;
}

function GridForm({ markets, onSuccess, onCancel }: GridFormProps) {
  const [selectedMarket, setSelectedMarket] = useState<{ index: number; label: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [gridSizeError, setGridSizeError] = useState<string | null>(null);

  const form = useForm<GridFormData>({
    resolver: zodResolver(gridSchema),
    defaultValues: { mode: "neutral", orderType: "post_only", limitPriceOffset: 0.4, executionMode: "normal", maxBudgetUsd: undefined, inventorySkewEnabled: false, followMarket: false },
  });

  const watchOrderType = form.watch("orderType");
  const watchAmountPerGrid = form.watch("amountPerGrid");
  const watchMarketIndex = form.watch("marketIndex");

  useEffect(() => {
    if (!selectedMarket) {
      setCurrentPrice(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/market/ticker/${selectedMarket.index}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data?.lastPrice > 0) setCurrentPrice(data.lastPrice);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedMarket?.index]);

  useEffect(() => {
    const market = markets.find(m => m.index === watchMarketIndex);
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
  }, [watchAmountPerGrid, watchMarketIndex, currentPrice, markets]);

  const createMutation = useCreateStrategy({
    mutation: {
      onSuccess: () => {
        toast.success("Strategi Dibuat", { description: "Bot Grid kamu siap." });
        onSuccess();
      },
      onError: (err: any) => {
        toast.error("Kesalahan", { description: err.message || "Gagal membuat strategi" });
      },
    },
  });

  const handleAIAnalyze = async () => {
    if (!selectedMarket) {
      toast.error("Pilih pasar terlebih dahulu", { description: "Pilih pasar sebelum menjalankan analisis AI." });
      return;
    }
    setAiLoading(true);
    setAiResult(null);
    try {
      const data = await fetchAIAnalysis({ strategyType: "grid", marketIndex: selectedMarket.index });
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
      const aiLower = lowerPrice ?? 0;
      const aiUpper = upperPrice ?? 0;
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
      toast.success("Analisis AI Selesai", { description: `Parameter grid diisi otomatis menggunakan ${data.modelTier}` });
    } catch (err: any) {
      toast.error("Analisis AI Gagal", { description: err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const onSubmit = (data: GridFormData) => {
    if (gridSizeError) return;
    createMutation.mutate({
      data: {
        name: data.name,
        type: "grid",
        marketIndex: data.marketIndex,
        gridConfig: {
          lowerPrice: data.lowerPrice,
          upperPrice: data.upperPrice,
          gridLevels: data.gridLevels,
          amountPerGrid: data.amountPerGrid,
          mode: data.mode,
          orderType: data.orderType,
          limitPriceOffset: (data.orderType === "limit" || data.orderType === "post_only") ? (data.limitPriceOffset ?? 0) : 0,
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
      },
    });
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} placeholder="mis. BTC Grid Netral" className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <MarketPicker
        markets={markets}
        selectedMarket={selectedMarket}
        onSelect={(m) => { setSelectedMarket(m); form.setValue("marketIndex", m.index, { shouldValidate: true }); setAiResult(null); }}
        error={form.formState.errors.marketIndex?.message}
      />

      <Button
        type="button"
        variant="outline"
        className="w-full border-primary/40 text-primary hover:bg-primary/10 gap-2"
        onClick={handleAIAnalyze}
        disabled={aiLoading || !selectedMarket}
      >
        {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {aiLoading ? "Menganalisis pasar untuk setup grid..." : "Isi Otomatis Parameter Grid (AI)"}
      </Button>

      {aiResult && <AIInsightCard result={aiResult} />}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Harga Bawah</Label>
          <Input type="text" inputMode="decimal" {...form.register("lowerPrice")} placeholder="1800" className="bg-background font-mono" />
          {form.formState.errors.lowerPrice && <p className="text-xs text-destructive">{form.formState.errors.lowerPrice.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Harga Atas</Label>
          <Input type="text" inputMode="decimal" {...form.register("upperPrice")} placeholder="2200" className="bg-background font-mono" />
          {form.formState.errors.upperPrice && <p className="text-xs text-destructive">{form.formState.errors.upperPrice.message}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Level Grid</Label>
          <Input type="text" inputMode="numeric" {...form.register("gridLevels")} placeholder="10" className="bg-background font-mono" />
          {form.formState.errors.gridLevels && <p className="text-xs text-destructive">{form.formState.errors.gridLevels.message}</p>}
        </div>
        <div className="space-y-2">
          <Label>Jumlah per Grid (USDC)</Label>
          <Input type="text" inputMode="decimal" {...form.register("amountPerGrid")} placeholder="50" className="bg-background font-mono" />
          {form.formState.errors.amountPerGrid && <p className="text-xs text-destructive">{form.formState.errors.amountPerGrid.message}</p>}
          {!form.formState.errors.amountPerGrid && gridSizeError && <p className="text-xs text-destructive">{gridSizeError}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Mode</Label>
          <Select onValueChange={(v: any) => form.setValue("mode", v)} value={form.watch("mode") || "neutral"}>
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
          <Select onValueChange={(v: any) => form.setValue("orderType", v)} value={form.watch("orderType") || "post_only"}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="post_only">Post-Only (Maker Only) ⭐⭐</SelectItem>
              <SelectItem value="limit">Limit (Maker/Taker) ⭐</SelectItem>
            </SelectContent>
          </Select>
          {form.watch("orderType") === "post_only" && (
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
            Buy: order ditempatkan <strong>di bawah</strong> harga pasar. Sell: <strong>di atas</strong>. (0.4 = 0.4% dari harga)
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>Mode Eksekusi</Label>
        <Select onValueChange={(v: any) => form.setValue("executionMode", v)} value={form.watch("executionMode") || "normal"}>
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
        <Input type="text" inputMode="decimal" {...form.register("maxBudgetUsd")} placeholder="mis. 50 (kosong = unlimited)" className="bg-background font-mono" />
        <p className="text-xs text-muted-foreground">Bot berhenti otomatis jika total fee yang dibayar mencapai batas ini.</p>
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="lighterSkewEnabled" {...form.register("inventorySkewEnabled")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="lighterSkewEnabled" className="text-sm font-medium cursor-pointer">Inventory Skew Management <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
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
          <input type="checkbox" id="lighterFollowMarket" {...form.register("followMarket")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="lighterFollowMarket" className="text-sm font-medium cursor-pointer">Follow Market Grid <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
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

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={createMutation.isPending} className="bg-teal-600 hover:bg-teal-700 text-white">
          {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Buat Bot Lighter
        </Button>
      </div>
    </form>
  );
}

export function CreateStrategyModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"grid" | "fr_arb">("grid");
  const { data: marketsData } = useGetOrderBooks();
  const markets = marketsData?.markets ?? [];

  const handleSuccess = () => {
    setOpen(false);
    setTab("grid");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTab("grid"); }}>
      <DialogTrigger asChild>
        <Button className="text-white shadow-lg gap-2" style={{ background: "linear-gradient(135deg, #0fd4aa 0%, #0aaa88 100%)" }}>
          <Plus className="w-4 h-4" />
          Strategi Baru
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto bg-card border-border shadow-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExchangeLogo exchange="lighter" size={20} />
            Strategi Baru — Lighter DEX
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v: any) => setTab(v)} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="grid">Grid</TabsTrigger>
            <TabsTrigger value="fr_arb" className="flex items-center gap-1.5">
              <Percent className="w-3.5 h-3.5" /> FR Arb
            </TabsTrigger>
          </TabsList>

          <TabsContent value="grid">
            <GridForm markets={markets} onSuccess={handleSuccess} onCancel={() => setOpen(false)} />
          </TabsContent>

          <TabsContent value="fr_arb">
            <LighterFrArbForm markets={markets} onSuccess={handleSuccess} onCancel={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
