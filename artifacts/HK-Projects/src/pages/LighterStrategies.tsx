import { useState } from "react";
import {
  useGetStrategies,
  useStartBot,
  useStopBot,
  useDeleteStrategy,
  useGetPnlChart,
  useGetAccountInfo,
  getGetStrategiesQueryKey,
  getGetPnlChartQueryKey,
  type Strategy,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Play, Square, Trash2, Activity, BarChart2, Zap, LineChart, Pencil, Eye, Wallet, ScrollText, TrendingUp, RefreshCw } from "lucide-react";
import { CreateStrategyModal } from "@/components/strategies/CreateStrategyModal";
import { EditStrategyModal } from "@/components/strategies/EditStrategyModal";
import { LighterLogDialog } from "@/components/lighter/LighterLogDialog";
import { PriceDisplay } from "@/components/ui/PriceDisplay";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { toast } from "sonner";
import { sumDec } from "@/lib/decimal";
import {
  ResponsiveContainer,
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

// ── Lighter Positions Dialog ────────────────────────────────────────────────────

function LighterPositionsDialog({
  open,
  onClose,
  positions,
  isLoading,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  positions: any[];
  isLoading: boolean;
  onRefresh: () => void;
}) {
  // FE-STRAT-001: akumulasi PnL via Decimal.js untuk hindari drift IEEE-754.
  const totalRealizedPnl = sumDec(positions, p => p.realizedPnl).toNumber();
  const totalUnrealizedPnl = sumDec(positions, p => p.unrealizedPnl).toNumber();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[780px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 text-base sm:text-lg">
            <span className="flex items-center gap-2 min-w-0">
              <TrendingUp className="w-5 h-5 text-amber-400" />
              <span className="break-words">Posisi Terbuka — Lighter Exchange</span>
            </span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="py-12 flex flex-col items-center text-muted-foreground">
            <TrendingUp className="w-12 h-12 mb-3 opacity-20" />
            <p>Tidak ada posisi terbuka di akun Lighter.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-background rounded-lg p-3 border border-border/50 text-center">
                <p className={`text-lg sm:text-xl font-bold font-mono ${totalUnrealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>
                  {totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(4)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Total Unrealized PnL</p>
              </div>
              <div className="bg-background rounded-lg p-3 border border-border/50 text-center">
                <p className={`text-lg sm:text-xl font-bold font-mono ${totalRealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>
                  {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Total Realized PnL</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full min-w-[680px] text-xs">
                <thead>
                  <tr className="bg-muted/50 text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium">Market</th>
                    <th className="text-left px-3 py-2 font-medium">Sisi</th>
                    <th className="text-right px-3 py-2 font-medium">Size</th>
                    <th className="text-right px-3 py-2 font-medium">Entry Price</th>
                    <th className="text-right px-3 py-2 font-medium">Mark Price</th>
                    <th className="text-right px-3 py-2 font-medium">Unrealized PnL</th>
                    <th className="text-right px-3 py-2 font-medium">Realized PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i} className="border-t border-border/30 hover:bg-muted/20">
                      <td className="px-3 py-2.5 font-mono font-bold">{p.marketSymbol}</td>
                      <td className="px-3 py-2.5">
                        <span className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded ${
                          p.side === "long"
                            ? "bg-success/15 text-success"
                            : "bg-destructive/15 text-destructive"
                        }`}>
                          {p.side}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">{Math.abs(p.size).toFixed(6)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">${p.entryPrice.toFixed(4)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">${p.markPrice.toFixed(4)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold ${
                        (p.unrealizedPnl ?? 0) >= 0 ? "text-success" : "text-destructive"
                      }`}>
                        {(p.unrealizedPnl ?? 0) >= 0 ? "+" : ""}${(p.unrealizedPnl ?? 0).toFixed(4)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold ${
                        (p.realizedPnl ?? 0) >= 0 ? "text-success" : "text-destructive"
                      }`}>
                        {(p.realizedPnl ?? 0) >= 0 ? "+" : ""}${(p.realizedPnl ?? 0).toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              * Data langsung dari Lighter Exchange. Realized PnL adalah akumulasi keuntungan/kerugian yang sudah direalisasikan pada posisi ini sejak dibuka.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── PnL Chart Dialog ───────────────────────────────────────────────────────────

function PnlChartDialog({
  strategyId,
  strategyName,
  open,
  onClose,
}: {
  strategyId: number;
  strategyName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useGetPnlChart(
    { strategyId },
    { query: { queryKey: getGetPnlChartQueryKey({ strategyId }), enabled: open } },
  );

  const chartData = data?.data ?? [];
  const hasData = chartData.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[700px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LineChart className="w-5 h-5 text-primary" />
            Grafik PnL — {strategyName}
          </DialogTitle>
        </DialogHeader>
        <div className="pt-2">
          {isLoading ? (
            <div className="h-64 bg-muted animate-pulse rounded-lg" />
          ) : !hasData ? (
            <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
              <BarChart2 className="w-12 h-12 mb-3 opacity-20" />
              <p>Belum ada data trade. Mulai bot untuk mulai melacak PnL.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
                <div className="bg-background rounded-lg p-3 border border-border/50">
                  <p className="text-xl sm:text-2xl font-bold font-mono text-success">
                    {chartData.reduce((a, d) => a + d.buys, 0)}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Beli</p>
                </div>
                <div className="bg-background rounded-lg p-3 border border-border/50">
                  <p className="text-xl sm:text-2xl font-bold font-mono text-destructive">
                    {chartData.reduce((a, d) => a + d.sells, 0)}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Jual</p>
                </div>
                <div className="bg-background rounded-lg p-3 border border-border/50">
                  <p className={`text-xl sm:text-2xl font-bold font-mono ${
                    (chartData[chartData.length - 1]?.cumulativePnl ?? 0) >= 0
                      ? "text-success"
                      : "text-destructive"
                  }`}>
                    ${(chartData[chartData.length - 1]?.cumulativePnl ?? 0).toFixed(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">PnL Kumulatif</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ReLineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                    formatter={(v: number, name: string) => [`$${v.toFixed(4)}`, name]}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="estimatedPnl" stroke="#10b981" strokeWidth={2} dot={false} name="PnL Harian" />
                  <Line type="monotone" dataKey="cumulativePnl" stroke="#6366f1" strokeWidth={2} dot={false} name="PnL Kumulatif" />
                </ReLineChart>
              </ResponsiveContainer>
              <p className="text-xs text-muted-foreground text-center mt-1">
                * Hanya mencakup trade yang dilakukan via bot ini (30 hari terakhir). Trade manual atau posisi sebelum bot aktif tidak termasuk dalam kalkulasi PnL.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Strategy Card ──────────────────────────────────────────────────────────────

function LighterStrategyCard({
  strategy,
  onToggle,
  onDelete,
  onShowChart,
  onEdit,
  onShowLog,
  isBusy,
  exchangePosition,
}: {
  strategy: Strategy;
  onToggle: () => void;
  onDelete: () => void;
  onShowChart: () => void;
  onEdit: () => void;
  onShowLog: () => void;
  isBusy: boolean;
  exchangePosition?: { realizedPnl?: number; unrealizedPnl?: number } | null;
}) {
  const rPnl = exchangePosition != null ? (exchangePosition.realizedPnl ?? null) : null;
  const uPnl = exchangePosition != null ? (exchangePosition.unrealizedPnl ?? 0) : null;

  return (
    <Card className="glass-panel glass-card-lighter flex flex-col overflow-hidden relative group">
      {strategy.isRunning && (
        <div className="running-bar-lighter absolute top-0 left-0 w-full animate-pulse" />
      )}

      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base sm:text-lg font-bold flex items-center gap-2 break-words">
              {strategy.name}
            </CardTitle>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded text-foreground">
                {strategy.marketSymbol}
              </span>
              <span className="text-xs uppercase font-bold text-primary tracking-wider">
                {strategy.type}
              </span>
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                Lighter
              </span>
            </div>
          </div>
          <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
            strategy.isRunning ? "bg-success/20 text-success" : "bg-muted text-muted-foreground"
          }`}>
            {strategy.isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            )}
            {strategy.isRunning ? "Berjalan" : "Berhenti"}
          </div>
        </div>
      </CardHeader>

      <CardContent className="py-4 flex-1">
        {strategy.type === "dca" && strategy.dcaConfig && (
          <div className="grid grid-cols-2 gap-y-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Jumlah</div>
              <div className="font-mono">${strategy.dcaConfig.amountPerOrder}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Interval</div>
              <div className="font-mono">{strategy.dcaConfig.intervalMinutes}m</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Sisi</div>
              <div className={`font-medium ${strategy.dcaConfig.side === "buy" ? "text-success" : "text-destructive"}`}>
                {strategy.dcaConfig.side.toUpperCase()}
              </div>
            </div>
            {strategy.dcaConfig.orderType && (
              <div>
                <div className="text-muted-foreground text-xs">Order Type</div>
                <div className="font-mono text-xs capitalize">{strategy.dcaConfig.orderType}</div>
              </div>
            )}
          </div>
        )}

        {strategy.type === "grid" && strategy.gridConfig && (
          <div className="grid grid-cols-2 gap-y-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Rentang</div>
              <div className="font-mono text-xs">
                ${strategy.gridConfig.lowerPrice} - ${strategy.gridConfig.upperPrice}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Level</div>
              <div className="font-mono">{strategy.gridConfig.gridLevels}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Per Grid</div>
              <div className="font-mono">${strategy.gridConfig.amountPerGrid}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Mode</div>
              <div className="font-mono capitalize">{strategy.gridConfig.mode}</div>
            </div>
            {strategy.gridConfig.stopLoss && (
              <div>
                <div className="text-muted-foreground text-xs">Stop Loss</div>
                <div className="font-mono text-destructive">${strategy.gridConfig.stopLoss}</div>
              </div>
            )}
            {strategy.gridConfig.takeProfit && (
              <div>
                <div className="text-muted-foreground text-xs">Take Profit</div>
                <div className="font-mono text-success">${strategy.gridConfig.takeProfit}</div>
              </div>
            )}
          </div>
        )}

        {strategy.stats && (strategy.stats.totalOrders > 0 || (strategy.stats.sessionOrders ?? 0) > 0) && (
          <div className="mt-4 pt-4 border-t border-border/50 space-y-1.5">
            {rPnl !== null && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <BarChart2 className="w-3 h-3" /> Realized PnL
                </span>
                <PriceDisplay value={rPnl} format="currency" showIcon />
              </div>
            )}
            {uPnl !== null && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" /> Unrealized PnL
                </span>
                <PriceDisplay value={uPnl} format="currency" showIcon />
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {strategy.isRunning && strategy.stats.sessionOrders !== null && strategy.stats.sessionOrders !== undefined ? (
                <>Sesi: {strategy.stats.sessionOrders} • Total: {strategy.stats.successfulOrders} / {strategy.stats.totalOrders}</>
              ) : (
                <>Trade: {strategy.stats.successfulOrders} / {strategy.stats.totalOrders}</>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-3 pb-4 border-t border-border/50 bg-background/50 grid grid-cols-4 sm:flex sm:justify-between gap-2">
        <Button
          variant={strategy.isRunning ? "destructive" : "default"}
          className={`col-span-4 sm:flex-1 ${!strategy.isRunning ? "bg-success hover:bg-success/90 text-success-foreground" : ""}`}
          onClick={onToggle}
          disabled={isBusy}
        >
          {strategy.isRunning ? (
            <><Square className="w-4 h-4 mr-2 fill-current" /> Hentikan Bot</>
          ) : (
            <><Play className="w-4 h-4 mr-2 fill-current" /> Mulai Bot</>
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-primary/10 hover:text-primary hover:border-primary/30"
          title="Lihat Grafik PnL"
          aria-label="Lihat Grafik PnL"
          onClick={onShowChart}
        >
          <Activity className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-teal-500/10 hover:text-teal-400 hover:border-teal-500/30"
          title="Lihat Log"
          aria-label="Lihat Log"
          onClick={onShowLog}
        >
          <ScrollText className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/30"
          title={strategy.isRunning ? "Lihat detail strategi" : "Edit Strategi"}
          aria-label={strategy.isRunning ? "Lihat detail strategi" : "Edit Strategi"}
          onClick={onEdit}
        >
          {strategy.isRunning ? <Eye className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
          title="Hapus strategi"
          aria-label="Hapus strategi"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Strategies() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetStrategies({
    query: { queryKey: getGetStrategiesQueryKey(), refetchInterval: 5000 },
  });
  const { data: account, isLoading: accountLoading, refetch: refetchAccount } = useGetAccountInfo();

  const [chartStrategy, setChartStrategy] = useState<{ id: number; name: string } | null>(null);
  const [editStrategy, setEditStrategy] = useState<Strategy | null>(null);
  const [logStrategyId, setLogStrategyId] = useState<number | null>(null);
  const [showPositions, setShowPositions] = useState(false);
  // FE-STRAT-010: konfirmasi sebelum stop bot agar user tidak salah klik
  const [stopTarget, setStopTarget] = useState<Strategy | null>(null);

  const strategies = data?.strategies ?? [];
  const logStrategy = strategies.find((s) => s.id === logStrategyId);
  const isConfigured = account?.isConfigured ?? false;

  const startMutation = useStartBot({
    mutation: {
      onSuccess: () => {
        toast.success("Bot Dimulai", { description: "Strategi sedang berjalan." });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? err?.message ?? "Gagal memulai bot.";
        toast.error("Tidak Dapat Memulai Bot", { description: msg });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
      },
    },
  });

  const stopMutation = useStopBot({
    mutation: {
      onSuccess: () => {
        toast.success("Bot Dihentikan", { description: "Strategi telah dijeda." });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? err?.message ?? "Gagal menghentikan bot.";
        toast.error("Tidak Dapat Menghentikan Bot", { description: msg });
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
      },
    },
  });

  const deleteMutation = useDeleteStrategy({
    mutation: {
      onSuccess: () => {
        toast.success("Strategi Dihapus");
        queryClient.invalidateQueries({ queryKey: getGetStrategiesQueryKey() });
      },
    },
  });

  const handleToggle = (strategy: Strategy) => {
    if (strategy.isRunning) {
      // FE-STRAT-010: buka dialog konfirmasi alih-alih langsung stop
      setStopTarget(strategy);
    } else {
      startMutation.mutate({ strategyId: strategy.id });
    }
  };

  const confirmStop = () => {
    if (!stopTarget) return;
    stopMutation.mutate({ strategyId: stopTarget.id });
    setStopTarget(null);
  };

  const handleDelete = (strategy: Strategy) => {
    if (confirm("Yakin ingin menghapus strategi ini?")) {
      deleteMutation.mutate({ id: strategy.id });
    }
  };

  const isBusy = startMutation.isPending || stopMutation.isPending;

  const totalUPnl = (account?.positions ?? []).reduce(
    (sum: number, p: any) => sum + (p.unrealizedPnl ?? 0),
    0
  );

  return (
    <div className="space-y-6 sm:space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground flex items-center gap-3">
            <ExchangeLogo exchange="lighter" size={32} className="rounded-lg" />
            Strategi Lighter
          </h1>
          <p className="text-muted-foreground mt-1">Bot trading otomatis di Lighter DEX</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap w-full sm:w-auto">
          {isConfigured && account?.totalEquity != null ? (
            <>
              <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 rounded-lg">
                <Wallet className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs text-muted-foreground">USDC:</span>
                <span className="font-mono font-bold text-amber-300">
                  ${account.totalEquity.toFixed(2)}
                </span>
              </div>
              {(account.positions?.length ?? 0) > 0 && (
                <button
                  onClick={() => setShowPositions(true)}
                  className="flex items-center gap-1.5 bg-background/50 border border-border/40 px-2.5 py-1.5 rounded-lg hover:border-amber-500/40 hover:bg-amber-500/5 transition-colors"
                  title="Lihat posisi exchange"
                >
                  <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs text-muted-foreground">
                    {account.positions?.length} posisi
                  </span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">uPnL:</span>
                  <span className={`font-mono font-bold text-xs ${totalUPnl >= 0 ? "text-amber-400" : "text-red-400"}`}>
                    {totalUPnl >= 0 ? "+" : ""}${totalUPnl.toFixed(2)}
                  </span>
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="w-4 h-4" />
              <span>Belum terkonfigurasi</span>
            </div>
          )}
          <CreateStrategyModal />
        </div>
      </header>

      <div className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg border text-sm w-fit max-w-full flex-wrap ${
        isConfigured ? "bg-teal-500/5 border-teal-500/20" : "bg-muted border-border"
      }`}>
        <ExchangeLogo exchange="lighter" size={14} />
        <span className="text-amber-300 font-medium">Lighter DEX</span>
        {isConfigured ? (
          <span className="text-green-400 font-medium">aktif ✓</span>
        ) : (
          <span className="text-yellow-400 font-medium">belum dikonfigurasi</span>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="glass-panel flex flex-col overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-2 flex-1">
                    <div className="h-5 w-32 bg-primary/10 animate-pulse rounded" />
                    <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="h-6 w-14 bg-muted animate-pulse rounded-full" />
                </div>
              </CardHeader>
              <CardContent className="space-y-3 flex-1">
                <div className="h-4 w-full bg-muted animate-pulse rounded" />
                <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
              </CardContent>
              <CardFooter className="flex gap-2 pt-3 border-t border-border/50">
                <div className="h-8 flex-1 bg-muted animate-pulse rounded" />
                <div className="h-8 w-8 bg-muted animate-pulse rounded" />
                <div className="h-8 w-8 bg-muted animate-pulse rounded" />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : !strategies.length ? (
        <div className="text-center py-20 bg-card rounded-2xl border border-border flex flex-col items-center">
          <Zap className="w-16 h-16 text-teal-400 mb-4 opacity-20" />
          <h3 className="text-xl font-bold text-foreground">Belum Ada Strategi Lighter</h3>
          <p className="text-muted-foreground mt-2 max-w-md mx-auto">
            {isConfigured
              ? 'Klik "Strategi Baru" untuk membuat DCA atau Grid bot di Lighter DEX.'
              : "Konfigurasikan kredensial Lighter terlebih dahulu sebelum membuat strategi."}
          </p>
          {isConfigured && (
            <div className="mt-6">
              <CreateStrategyModal />
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {strategies.map((strategy) => (
            <LighterStrategyCard
              key={strategy.id}
              strategy={strategy}
              onToggle={() => handleToggle(strategy)}
              onDelete={() => handleDelete(strategy)}
              onShowChart={() => setChartStrategy({ id: strategy.id, name: strategy.name })}
              onEdit={() => setEditStrategy(strategy)}
              onShowLog={() => setLogStrategyId(strategy.id)}
              isBusy={isBusy}
              exchangePosition={(account?.positions ?? []).find(
                (p: any) => p.marketSymbol === strategy.marketSymbol
              ) ?? null}
            />
          ))}
        </div>
      )}

      {chartStrategy && (
        <PnlChartDialog
          strategyId={chartStrategy.id}
          strategyName={chartStrategy.name}
          open={!!chartStrategy}
          onClose={() => setChartStrategy(null)}
        />
      )}

      <EditStrategyModal
        strategy={editStrategy}
        onClose={() => setEditStrategy(null)}
        viewOnly={editStrategy?.isRunning ?? false}
      />

      {logStrategy && (
        <LighterLogDialog
          strategyId={logStrategy.id}
          strategyName={logStrategy.name}
          open={true}
          onClose={() => setLogStrategyId(null)}
        />
      )}

      <LighterPositionsDialog
        open={showPositions}
        onClose={() => setShowPositions(false)}
        positions={account?.positions ?? []}
        isLoading={accountLoading}
        onRefresh={() => refetchAccount()}
      />

      {/* FE-STRAT-010: konfirmasi stop bot */}
      <AlertDialog
        open={stopTarget !== null}
        onOpenChange={(open) => !open && setStopTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Hentikan bot &quot;{stopTarget?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Bot akan berhenti menempatkan order baru.{" "}
              <strong>Posisi terbuka &amp; order pending di exchange tetap aktif</strong>{" "}
              dan harus di-manage manual.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmStop}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hentikan Bot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
