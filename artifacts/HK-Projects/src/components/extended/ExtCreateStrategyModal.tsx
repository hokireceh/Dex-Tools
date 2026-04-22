import { useState } from "react";
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
import { Plus, Loader2, ChevronsUpDown, Check, Sparkles, TrendingUp, TrendingDown, Minus, Percent } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { fetchAIAnalysis as fetchAiParamsShared } from "@/lib/aiAnalysis";

// ── Tipe market dari API ────────────────────────────────────────────────────────
interface ExtMarket {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number;
  markPrice: number;
  tickSize: number;
  stepSize?: number;
  minBaseAmount?: number;
  minOrderValue?: number;
}

// ── Fetch market dari API Extended (bukan hardcode) ────────────────────────────
async function fetchExtendedMarkets(): Promise<ExtMarket[]> {
  const res = await fetch("/api/extended/strategies/markets", { credentials: "include" });
  if (!res.ok) throw new Error("Gagal memuat daftar market");
  const json = await res.json();
  return json.markets ?? [];
}

// ── Zod schema FR Arb ──────────────────────────────────────────────────────────

const extFrArbSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  marketSymbol: z.string().min(1, "Pilih market terlebih dahulu"),
  side: z.enum(["auto", "long", "short"]),
  positionSize: z.coerce.number().positive("Harus positif"),
  entryFrThreshold: z.coerce.number().positive("Harus positif").max(10, "Maksimal 10%/jam"),
  exitFrThreshold: z.coerce.number().positive("Harus positif").max(10, "Maksimal 10%/jam"),
  maxHoldHours: z.coerce.number().int("Harus bilangan bulat").min(1).max(720),
  orderType: z.enum(["market", "limit", "post_only"]),
  limitPriceOffset: z.coerce.number().optional(),
  stopLoss: z.coerce.number().optional().nullable(),
});

const optionalPositiveNumber = z.preprocess(
  (val) => {
    if (val === "" || val === null || val === undefined) return undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : n;
  },
  z.number().positive("Harus angka positif").optional()
);

const extGridSchema = z.object({
  name: z.string().min(3, "Nama minimal 3 karakter"),
  marketSymbol: z.string().min(1, "Pilih market terlebih dahulu"),
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

type ExtFrArbFormData = z.infer<typeof extFrArbSchema>;
type ExtGridFormData = z.infer<typeof extGridSchema>;

// ── Market Picker (dinamis dari API) ───────────────────────────────────────────

function ExtMarketPicker({
  selected,
  onSelect,
  error,
  markets,
  isLoading,
}: {
  selected: string | null;
  onSelect: (symbol: string) => void;
  error?: string;
  markets: ExtMarket[];
  isLoading: boolean;
}) {
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
            disabled={isLoading}
            className="w-full justify-between bg-background font-normal"
          >
            {isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Memuat market...
              </span>
            ) : selected ? (
              <span className="font-mono text-sm">{selected}</span>
            ) : (
              <span className="text-muted-foreground">Pilih market (mis. ETH-USD)...</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0 z-[200]" align="start">
          <Command>
            <CommandInput placeholder="Cari market (mis. HYPE, ETH, BTC)..." />
            <CommandList className="max-h-[280px] overflow-y-auto">
              <CommandEmpty>Market tidak ditemukan.</CommandEmpty>
              <CommandGroup heading={`${markets.length} market tersedia`}>
                {markets.map(m => (
                  <CommandItem
                    key={m.symbol}
                    value={`${m.symbol} ${m.baseAsset}`}
                    onSelect={() => {
                      onSelect(m.symbol);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", selected === m.symbol ? "opacity-100" : "opacity-0")} />
                    <span className="font-mono text-sm">{m.symbol}</span>
                    {m.markPrice > 0 && (
                      <span className="ml-auto text-xs text-muted-foreground font-mono">
                        ${m.markPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ── AI Result types & card ─────────────────────────────────────────────────────

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
    bullish: <TrendingUp className="w-3.5 h-3.5 text-green-400" />,
    bearish: <TrendingDown className="w-3.5 h-3.5 text-destructive" />,
    sideways: <Minus className="w-3.5 h-3.5 text-yellow-400" />,
    volatile: <Sparkles className="w-3.5 h-3.5 text-primary" />,
  }[result.marketCondition];

  const riskColor = {
    low: "text-green-400",
    medium: "text-yellow-400",
    high: "text-destructive",
  }[result.riskLevel];

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
          <Sparkles className="w-3.5 h-3.5" />
          Analisis AI — {result.modelTier}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {conditionIcon}
            <span className="capitalize">{result.marketCondition === "sideways" ? "Sideways" : result.marketCondition === "bullish" ? "Bullish" : result.marketCondition === "bearish" ? "Bearish" : "Volatile"}</span>
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

// ── Sanitize AI numbers (guard against European decimal format) ──────────────
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

// ── API helpers ─────────────────────────────────────────────────────────────────

async function createExtendedStrategy(payload: object) {
  const res = await fetch("/api/extended/strategies/", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Gagal membuat strategi Extended");
  return json;
}

const fetchAiParams = (strategyType: "dca" | "grid", marketSymbol: string) =>
  fetchAiParamsShared({ strategyType, marketSymbol, exchange: "extended" });

// ── Tombol AI ─────────────────────────────────────────────────────────────────

function AiAutoFillButton({
  marketSymbol,
  strategyType,
  onResult,
  disabled,
}: {
  marketSymbol: string | null;
  strategyType: "dca" | "grid";
  onResult: (data: any) => void;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!marketSymbol) {
      toast.error("Pilih market dulu", { description: "Pilih market Extended sebelum menggunakan AI." });
      return;
    }
    setLoading(true);
    try {
      const data = await fetchAiParams(strategyType, marketSymbol);
      onResult(data);
      toast.success("Parameter diisi otomatis AI", { description: `Rekomendasi ${strategyType.toUpperCase()} untuk ${marketSymbol} berhasil dimuat.` });
    } catch (err: any) {
      toast.error("AI Gagal", { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={disabled || loading || !marketSymbol}
      className="w-full gap-2 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200 hover:border-emerald-500/50"
    >
      {loading
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <Sparkles className="w-3.5 h-3.5" />}
      {loading ? "Menganalisis pasar..." : "Isi Otomatis Parameter (AI)"}
    </Button>
  );
}

// ── FR Arb Form ────────────────────────────────────────────────────────────────

function ExtFrArbForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { data: frMarkets = [], isLoading: frMarketsLoading } = useQuery({
    queryKey: ["extended-markets"],
    queryFn: fetchExtendedMarkets,
    staleTime: 60_000,
    retry: 2,
  });

  const form = useForm<ExtFrArbFormData>({
    resolver: zodResolver(extFrArbSchema),
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

  const onSubmit = async (data: ExtFrArbFormData) => {
    setLoading(true);
    try {
      await createExtendedStrategy({
        name: data.name,
        type: "funding_arb",
        marketSymbol: data.marketSymbol,
        frArbConfig: {
          positionSize: data.positionSize,
          entryFrThreshold: data.entryFrThreshold / 100,
          exitFrThreshold: data.exitFrThreshold / 100,
          maxHoldHours: data.maxHoldHours,
          side: data.side,
          orderType: data.orderType,
          limitPriceOffset: data.limitPriceOffset ?? undefined,
          stopLoss: data.stopLoss ?? null,
        },
      });
      toast.success("Strategi FR Arb Dibuat", { description: `Bot ${data.name} siap untuk Extended DEX.` });
      onSuccess();
    } catch (err: any) {
      toast.error("Kesalahan", { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      <div className="p-3 rounded-lg bg-violet-500/5 border border-violet-500/20 text-xs text-muted-foreground">
        Bot masuk posisi jika |FR| ≥ <strong>Entry Threshold</strong>, dan keluar jika
        |FR| ≤ <strong>Exit Threshold</strong> atau durasi melebihi <strong>Max Hold</strong>.
        Polling setiap <strong>15 menit</strong>.
      </div>

      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} placeholder="mis. ETH FR Arb Extended" className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <ExtMarketPicker
        selected={selectedSymbol}
        onSelect={(sym) => {
          setSelectedSymbol(sym);
          form.setValue("marketSymbol", sym, { shouldValidate: true });
        }}
        error={form.formState.errors.marketSymbol?.message}
        markets={frMarkets}
        isLoading={frMarketsLoading}
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Sisi Posisi</Label>
          <Select onValueChange={(v: any) => form.setValue("side", v)} value={form.watch("side") || "auto"}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto"><span className="text-violet-300 font-bold">AUTO</span> — ikuti sinyal FR</SelectItem>
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
              <SelectItem value="post_only">Post Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {watchOrderType !== "market" && (
        <div className="space-y-2">
          <Label>Limit Price Offset (%) <span className="ml-1 text-[10px] text-muted-foreground">opsional, default 0.1%</span></Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="0.1" className="bg-background font-mono" />
        </div>
      )}

      <div className="space-y-2">
        <Label>Stop Loss (harga absolut) <span className="ml-1 text-[10px] text-muted-foreground">opsional — kosongkan = tidak pakai</span></Label>
        <Input type="text" inputMode="decimal" {...form.register("stopLoss")} placeholder="mis. 1500 (kosongkan = tidak pakai SL)" className="bg-background font-mono" />
      </div>

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={loading} className="bg-violet-600 hover:bg-violet-700 text-white">
          {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Buat FR Arb Bot
        </Button>
      </div>
    </form>
  );
}

// ── Grid Form ──────────────────────────────────────────────────────────────────

function ExtGridForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIResult | null>(null);

  const { data: markets = [], isLoading: marketsLoading } = useQuery({
    queryKey: ["extended-markets"],
    queryFn: fetchExtendedMarkets,
    staleTime: 60_000,
    retry: 2,
  });

  const form = useForm<ExtGridFormData>({
    resolver: zodResolver(extGridSchema),
    defaultValues: { mode: "neutral", orderType: "limit", limitPriceOffset: 0, executionMode: "normal", maxBudgetUsd: undefined, inventorySkewEnabled: false, followMarket: false },
  });

  const watchOrderType = form.watch("orderType");

  const handleAiResult = (data: any) => {
    const p = data?.grid_params;
    if (!p) return;
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
    if (data.reasoning) {
      setAiResult({
        reasoning: data.reasoning,
        marketCondition: data.marketCondition,
        riskLevel: data.riskLevel,
        confidence: data.confidence,
        modelUsed: data.modelUsed,
        modelTier: data.modelTier,
      });
    }
  };

  const onSubmit = async (data: ExtGridFormData) => {
    const mkt = markets.find(m => m.symbol === selectedSymbol);
    // GRID-NEW-004: Cek gridSpacing >= tickSize sebelum submit ke exchange.
    const tickSize = mkt?.tickSize;
    if (tickSize && tickSize > 0) {
      const spacing = (data.upperPrice - data.lowerPrice) / data.gridLevels;
      if (spacing < tickSize) {
        form.setError("gridLevels", {
          message: `Jarak grid (${spacing.toFixed(6)}) lebih kecil dari tickSize exchange (${tickSize})`,
        });
        return;
      }
    }
    // FE-STRAT-002: Cek amountPerGrid >= minBaseAmount (ROUTE-EXT-MARKETS-MIN-SIZE-001).
    const minBase = mkt?.minBaseAmount ?? 0;
    const lastPrice = mkt?.lastPrice ?? 0;
    if (minBase > 0 && lastPrice > 0) {
      const estimatedBase = data.amountPerGrid / lastPrice;
      if (estimatedBase < minBase) {
        form.setError("amountPerGrid", {
          message: `Jumlah terlalu kecil. Min ~${minBase} ${mkt?.baseAsset ?? ""} (≈${(minBase * lastPrice).toFixed(2)} USDC)`,
        });
        return;
      }
    }
    setLoading(true);
    try {
      await createExtendedStrategy({
        name: data.name,
        type: "grid",
        marketSymbol: data.marketSymbol,
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
      toast.success("Strategi Extended Dibuat", { description: "Bot Grid Extended kamu siap." });
      onSuccess();
    } catch (err: any) {
      toast.error("Kesalahan", { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 space-y-4">
      <div className="space-y-2">
        <Label>Nama Strategi</Label>
        <Input {...form.register("name")} placeholder="mis. ETH Grid Netral" className="bg-background" />
        {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>

      <ExtMarketPicker
        selected={selectedSymbol}
        onSelect={(sym) => {
          setSelectedSymbol(sym);
          form.setValue("marketSymbol", sym, { shouldValidate: true });
          setAiResult(null);
        }}
        error={form.formState.errors.marketSymbol?.message}
        markets={markets}
        isLoading={marketsLoading}
      />

      <AiAutoFillButton
        marketSymbol={selectedSymbol}
        strategyType="grid"
        onResult={handleAiResult}
        disabled={loading}
      />

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
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Mode</Label>
          <Select onValueChange={(v: any) => form.setValue("mode", v)} value={form.watch("mode") || "neutral"}>
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
          <Select onValueChange={(v: any) => form.setValue("orderType", v)} value={form.watch("orderType") || "limit"}>
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
          <Label>
            Limit Price Offset (%)
            <span className="ml-1.5 text-xs text-muted-foreground">— offset dari harga pasar</span>
          </Label>
          <Input type="text" inputMode="decimal" {...form.register("limitPriceOffset")} placeholder="mis. 0.4" className="bg-background font-mono" />
        </div>
      )}

      <div className="space-y-2">
        <Label>Mode Eksekusi</Label>
        <Select onValueChange={(v: any) => form.setValue("executionMode", v)} value={form.watch("executionMode") || "normal"}>
          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="aggressive">Agresif — spread 0.5× (lebih banyak fill)</SelectItem>
            <SelectItem value="normal">Normal — spread 1× (default)</SelectItem>
            <SelectItem value="passive">Pasif — spread 1.5× (lebih sedikit fill, jaminan maker fee)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Mengatur lebar spread dari Limit Price Offset.</p>
      </div>

      <div className="space-y-2">
        <Label>Budget Maksimum (USD) <span className="text-xs text-muted-foreground">(opsional)</span></Label>
        <Input type="text" inputMode="decimal" {...form.register("maxBudgetUsd")} placeholder="mis. 50 (kosong = unlimited)" className="bg-background font-mono" />
        <p className="text-xs text-muted-foreground">Bot berhenti otomatis jika total fee yang dibayar mencapai batas ini.</p>
      </div>

      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center gap-3">
          <input type="checkbox" id="extSkewEnabled" {...form.register("inventorySkewEnabled")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="extSkewEnabled" className="text-sm font-medium cursor-pointer">Inventory Skew Management <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
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
          <input type="checkbox" id="extFollowMarket" {...form.register("followMarket")} className="h-4 w-4 rounded border-border" />
          <div>
            <Label htmlFor="extFollowMarket" className="text-sm font-medium cursor-pointer">Follow Market Grid <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
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

      <div className="pt-4 flex justify-end gap-3 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={loading} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Buat Bot Extended
        </Button>
      </div>
    </form>
  );
}

// ── Modal utama ────────────────────────────────────────────────────────────────

export function ExtCreateStrategyModal({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"grid" | "fr_arb">("grid");
  const queryClient = useQueryClient();

  const handleSuccess = () => {
    setOpen(false);
    setTab("grid");
    queryClient.invalidateQueries({ queryKey: ["ext-strategies"] });
    onCreated?.();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTab("grid"); }}>
      <DialogTrigger asChild>
        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
          <Plus className="w-4 h-4" />
          Strategi Extended Baru
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[580px] bg-card border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExchangeLogo exchange="extended" size={20} />
            Strategi Baru — Extended DEX
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="grid">Grid</TabsTrigger>
            <TabsTrigger value="fr_arb" className="flex items-center gap-1.5">
              <Percent className="w-3.5 h-3.5" /> FR Arb
            </TabsTrigger>
          </TabsList>
          <TabsContent value="grid">
            <ExtGridForm onSuccess={handleSuccess} onCancel={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="fr_arb">
            <ExtFrArbForm onSuccess={handleSuccess} onCancel={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
