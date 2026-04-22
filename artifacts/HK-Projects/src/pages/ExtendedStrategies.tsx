import { useState } from "react";
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
import { Play, Square, Trash2, Activity, BarChart2, Zap, LineChart, Pencil, Eye, ScrollText, History, TrendingUp, RefreshCw, Percent } from "lucide-react";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { ExtCreateStrategyModal } from "@/components/extended/ExtCreateStrategyModal";
import { ExtEditStrategyModal } from "@/components/extended/ExtEditStrategyModal";
import { ExtLogDialog } from "@/components/extended/ExtLogDialog";
import { ExtAccountWidget } from "@/components/extended/ExtAccountWidget";
import { PriceDisplay } from "@/components/ui/PriceDisplay";
import { safeDec } from "@/lib/decimal";
import { toast } from "sonner";
import {
  useExtendedStrategies,
  useStartExtendedBot,
  useStopExtendedBot,
  useDeleteExtendedStrategy,
  useExtendedPnlChart,
  useExtendedAccount,
  useExtendedTrades,
  useExtendedFundingHistory,
  useExtendedPositionsHistory,
  useStartExtendedFrArb,
  useStopExtendedFrArb,
  EXT_QUERY_KEYS,
  type ExtStrategy,
  type ExtAccount,
} from "@/hooks/useExtended";
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

// ── Extended Positions Dialog ──────────────────────────────────────────────────

function ExtPositionsDialog({
  open,
  onClose,
  positions,
  isLoading,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  positions: ExtAccount["positions"];
  isLoading: boolean;
  onRefresh: () => void;
}) {
  const totalUnrealized = positions.reduce((sum, p) => sum + (p.unrealisedPnl ?? 0), 0);
  const totalRealized = positions.reduce((sum, p) => sum + (p.realisedPnl ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[780px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 text-base sm:text-lg">
            <div className="flex items-center gap-2 min-w-0">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
              <span className="break-words">Posisi Terbuka — Extended Exchange</span>
            </div>
            <button
              onClick={onRefresh}
              className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="h-40 bg-muted animate-pulse rounded-lg mt-2" />
        ) : positions.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-muted-foreground">
            <TrendingUp className="w-10 h-10 mb-2 opacity-20" />
            <p>Tidak ada posisi terbuka saat ini.</p>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-background rounded-lg p-3 border border-border/50 text-center">
                <p className={`text-lg sm:text-xl font-bold font-mono ${totalUnrealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(4)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Total Unrealized PnL</p>
              </div>
              <div className="bg-background rounded-lg p-3 border border-border/50 text-center">
                <p className={`text-lg sm:text-xl font-bold font-mono ${totalRealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {totalRealized >= 0 ? "+" : ""}${totalRealized.toFixed(4)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Total Realized PnL</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-border/50 bg-muted/40">
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Market</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Sisi</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Size</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Entry Price</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Mark Price</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Unreal. PnL</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Realized PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const uPnl = p.unrealisedPnl ?? 0;
                    const rPnl = p.realisedPnl ?? 0;
                    return (
                      <tr key={p.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2.5 font-mono font-semibold text-emerald-300">{p.market}</td>
                        <td className="px-3 py-2.5">
                          <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                            p.side === "long" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                          }`}>
                            {p.side}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">{safeDec(p.size).toFixed(4)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">${p.openPrice.toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">${p.markPrice.toFixed(2)}</td>
                        <td className={`px-3 py-2.5 text-right font-mono font-semibold ${uPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {uPnl >= 0 ? "+" : ""}${uPnl.toFixed(4)}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-mono font-semibold ${rPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {rPnl >= 0 ? "+" : ""}${rPnl.toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              * Data langsung dari Extended Exchange.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Trade / Funding / Positions History Dialog (H-02) ─────────────────────────

type HistoryTab = "trades" | "funding" | "positions";

function ExtHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<HistoryTab>("trades");
  const { data: trades = [], isLoading: tradesLoading } = useExtendedTrades(undefined, open && tab === "trades");
  const { data: funding = [], isLoading: fundingLoading } = useExtendedFundingHistory(undefined, open && tab === "funding");
  const { data: positions = [], isLoading: positionsLoading } = useExtendedPositionsHistory(undefined, open && tab === "positions");

  const fmtDate = (ts: number) => ts ? new Date(ts).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" }) : "-";
  const fmtNum = (v: string | number | undefined, decimals = 4) =>
    v !== undefined && v !== "" ? safeDec(v).toFixed(decimals) : "-";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[780px] flex flex-col bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-300">
            <History className="w-4 h-4" /> Riwayat Akun Extended
          </DialogTitle>
        </DialogHeader>

        {/* Tab buttons */}
        <div className="flex gap-1 border-b border-border pb-2 overflow-x-auto">
          {([["trades", "Trade"], ["funding", "Funding"], ["positions", "Posisi"]] as [HistoryTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                tab === key
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="overflow-auto flex-1 min-h-0 text-xs">
          {/* ── Trade History ── */}
          {tab === "trades" && (
            tradesLoading ? (
              <div className="py-8 text-center text-muted-foreground">Memuat trade history…</div>
            ) : trades.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">Belum ada trade.</div>
            ) : (
              <table className="w-full min-w-[560px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Waktu</th>
                    <th className="text-left py-2 pr-3">Market</th>
                    <th className="text-left py-2 pr-3">Side</th>
                    <th className="text-right py-2 pr-3">Harga</th>
                    <th className="text-right py-2 pr-3">Qty</th>
                    <th className="text-right py-2 pr-3">Nilai</th>
                    <th className="text-right py-2">Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-1.5 pr-3 text-muted-foreground">{fmtDate(t.createdTime)}</td>
                      <td className="py-1.5 pr-3 font-mono">{t.market}</td>
                      <td className={`py-1.5 pr-3 font-bold ${t.side === "BUY" ? "text-green-400" : "text-red-400"}`}>{t.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(t.price, 2)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(t.qty, 4)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(t.value, 2)}</td>
                      <td className="py-1.5 text-right font-mono text-muted-foreground">{fmtNum(t.fee, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ── Funding History ── */}
          {tab === "funding" && (
            fundingLoading ? (
              <div className="py-8 text-center text-muted-foreground">Memuat funding history…</div>
            ) : funding.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">Belum ada pembayaran funding.</div>
            ) : (
              <table className="w-full min-w-[480px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Waktu</th>
                    <th className="text-left py-2 pr-3">Market</th>
                    <th className="text-left py-2 pr-3">Side</th>
                    <th className="text-right py-2 pr-3">Size</th>
                    <th className="text-right py-2 pr-3">Rate</th>
                    <th className="text-right py-2">Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {funding.map((f) => (
                    <tr key={f.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-1.5 pr-3 text-muted-foreground">{fmtDate(f.paidTime)}</td>
                      <td className="py-1.5 pr-3 font-mono">{f.market}</td>
                      <td className={`py-1.5 pr-3 font-bold ${f.side === "LONG" ? "text-green-400" : "text-red-400"}`}>{f.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(f.size, 4)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(f.fundingRate, 6)}</td>
                      <td className={`py-1.5 text-right font-mono font-bold ${safeDec(f.fundingFee).isNegative() ? "text-red-400" : "text-green-400"}`}>
                        {fmtNum(f.fundingFee, 4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ── Positions History ── */}
          {tab === "positions" && (
            positionsLoading ? (
              <div className="py-8 text-center text-muted-foreground">Memuat riwayat posisi…</div>
            ) : positions.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">Belum ada riwayat posisi.</div>
            ) : (
              <table className="w-full min-w-[520px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Dibuka</th>
                    <th className="text-left py-2 pr-3">Market</th>
                    <th className="text-left py-2 pr-3">Side</th>
                    <th className="text-right py-2 pr-3">Size</th>
                    <th className="text-right py-2 pr-3">Open</th>
                    <th className="text-right py-2 pr-3">Close</th>
                    <th className="text-right py-2">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const pnl = safeDec(p.realisedPnl);
                    const pnlNeg = pnl.isNegative();
                    return (
                      <tr key={p.id} className="border-b border-border/40 hover:bg-muted/30">
                        <td className="py-1.5 pr-3 text-muted-foreground">{fmtDate(p.createdTime)}</td>
                        <td className="py-1.5 pr-3 font-mono">{p.market}</td>
                        <td className={`py-1.5 pr-3 font-bold ${p.side === "LONG" ? "text-green-400" : "text-red-400"}`}>{p.side}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(p.size, 4)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(p.openPrice, 2)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtNum(p.exitPrice, 2)}</td>
                        <td className={`py-1.5 text-right font-mono font-bold ${pnlNeg ? "text-red-400" : "text-green-400"}`}>
                          {pnlNeg ? "" : "+"}{fmtNum(p.realisedPnl, 2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── PnL Chart Dialog ───────────────────────────────────────────────────────────

function ExtPnlChartDialog({
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
  const { data: chartData = [], isLoading } = useExtendedPnlChart(strategyId, open);
  const hasData = chartData.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[700px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LineChart className="w-5 h-5 text-emerald-400" />
            Grafik PnL Extended — {strategyName}
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
                    (chartData[chartData.length - 1]?.cumulativePnl ?? 0) >= 0 ? "text-success" : "text-destructive"
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
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                    }}
                    formatter={(v: number, name: string) => [`$${v.toFixed(4)}`, name]}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="estimatedPnl" stroke="#10b981" strokeWidth={2} dot={false} name="PnL Harian" />
                  <Line type="monotone" dataKey="cumulativePnl" stroke="#a78bfa" strokeWidth={2} dot={false} name="PnL Kumulatif" />
                </ReLineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Strategy Card ──────────────────────────────────────────────────────────────

function ExtStrategyCard({
  strategy,
  onToggle,
  onDelete,
  onShowChart,
  onEdit,
  onShowLog,
  isBusy,
  exchangePosition,
}: {
  strategy: ExtStrategy;
  onToggle: () => void;
  onDelete: () => void;
  onShowChart: () => void;
  onEdit: () => void;
  onShowLog: () => void;
  isBusy: boolean;
  exchangePosition?: { realisedPnl?: number; unrealisedPnl?: number } | null;
}) {
  const rPnl = exchangePosition != null ? (exchangePosition.realisedPnl ?? null) : null; // exchange — real-time
  const uPnl = exchangePosition != null ? (exchangePosition.unrealisedPnl ?? 0) : null; // exchange — real-time mark price

  return (
    <Card className="glass-panel glass-card-extended flex flex-col overflow-hidden relative group">
      {strategy.isRunning && (
        <div className="running-bar-extended absolute top-0 left-0 w-full animate-pulse" />
      )}

      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base sm:text-lg font-bold break-words">{strategy.name}</CardTitle>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="text-xs font-mono bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/20">
                {strategy.marketSymbol}
              </span>
              <span className="text-xs uppercase font-bold text-emerald-400 tracking-wider">
                {strategy.type}
              </span>
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                Extended
              </span>
            </div>
          </div>
          <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
            strategy.isRunning ? "bg-emerald-500/20 text-emerald-300" : "bg-muted text-muted-foreground"
          }`}>
            {strategy.isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
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
            <div>
              <div className="text-muted-foreground text-xs">Order Type</div>
              <div className="font-mono text-xs capitalize">{strategy.dcaConfig.orderType}</div>
            </div>
          </div>
        )}

        {strategy.type === "grid" && strategy.gridConfig && (
          <div className="grid grid-cols-2 gap-y-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Rentang</div>
              <div className="font-mono text-xs">
                ${strategy.gridConfig.lowerPrice} – ${strategy.gridConfig.upperPrice}
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

        {strategy.totalOrders > 0 && (
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
              Trade: {strategy.successfulOrders} / {strategy.totalOrders}
            </div>
          </div>
        )}

        {strategy.type === "dca" && strategy.isRunning && strategy.nextRunAtLive && (
          <div className="mt-2 text-xs text-muted-foreground">
            Eksekusi berikutnya:{" "}
            <span className="font-mono text-emerald-400">
              {new Date(strategy.nextRunAtLive).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}
            </span>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-3 pb-4 border-t border-border/50 bg-background/50 grid grid-cols-4 sm:flex sm:justify-between gap-2">
        <Button
          variant={strategy.isRunning ? "destructive" : "default"}
          className={`col-span-4 sm:flex-1 ${!strategy.isRunning ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}`}
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
          className="w-full sm:w-9 shrink-0 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
          title="Lihat Grafik PnL"
          aria-label="Lihat Grafik PnL"
          onClick={onShowChart}
        >
          <Activity className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-sky-500/10 hover:text-sky-400 hover:border-sky-500/30"
          title="Lihat Log"
          aria-label="Lihat Log"
          onClick={onShowLog}
        >
          <ScrollText className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-full sm:w-9 shrink-0 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
          title={strategy.isRunning ? "Lihat detail strategi" : "Edit strategi"}
          aria-label={strategy.isRunning ? "Lihat detail strategi" : "Edit strategi"}
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

// ── FR Arb Strategy Card ───────────────────────────────────────────────────────

function ExtFrArbStrategyCard({
  strategy,
  onToggle,
  onDelete,
  onShowLog,
  isBusy,
}: {
  strategy: ExtStrategy;
  onToggle: () => void;
  onDelete: () => void;
  onShowLog: () => void;
  isBusy: boolean;
}) {
  const cfg = strategy.frArbConfig;
  const st = strategy.frArbState;

  return (
    <Card className="glass-panel glass-card-extended flex flex-col overflow-hidden relative group border-violet-500/20">
      {strategy.isRunning && (
        <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-violet-500 to-purple-500 animate-pulse" />
      )}

      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base sm:text-lg font-bold break-words">{strategy.name}</CardTitle>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="text-xs font-mono bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/20">
                {strategy.marketSymbol}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider text-violet-300 bg-violet-500/10 px-2 py-0.5 rounded border border-violet-500/20 flex items-center gap-1">
                <Percent className="w-2.5 h-2.5" /> FR ARB
              </span>
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                Extended
              </span>
            </div>
          </div>
          <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
            strategy.isRunning ? "bg-violet-500/20 text-violet-300" : "bg-muted text-muted-foreground"
          }`}>
            {strategy.isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
            )}
            {strategy.isRunning ? "Berjalan" : "Berhenti"}
          </div>
        </div>
      </CardHeader>

      <CardContent className="py-4 flex-1 space-y-3">
        {cfg && (
          <div className="grid grid-cols-2 gap-y-2.5 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Sisi</div>
              <div className={`font-bold uppercase text-sm ${
                cfg.side === "long" ? "text-green-400"
                : cfg.side === "short" ? "text-red-400"
                : "text-violet-300"
              }`}>
                {cfg.side}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Size</div>
              <div className="font-mono">${cfg.positionSize}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Entry Threshold</div>
              <div className="font-mono text-violet-300">{(cfg.entryFrThreshold * 100).toFixed(4)}%/jam</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Exit Threshold</div>
              <div className="font-mono text-violet-300">{(cfg.exitFrThreshold * 100).toFixed(4)}%/jam</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Max Hold</div>
              <div className="font-mono">{cfg.maxHoldHours}j</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Order Type</div>
              <div className="font-mono text-xs uppercase">{cfg.orderType}</div>
            </div>
            {cfg.stopLoss != null && (
              <div>
                <div className="text-muted-foreground text-xs">Stop Loss</div>
                <div className="font-mono text-destructive">${cfg.stopLoss}</div>
              </div>
            )}
          </div>
        )}

        {/* State section */}
        {st && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                st.isInPosition
                  ? "bg-green-500/15 text-green-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {st.isInPosition ? "DALAM POSISI" : "TIDAK POSISI"}
              </span>
              {st.isInPosition && st.positionSide && (
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                  st.positionSide === "long" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
                }`}>
                  {st.positionSide}
                </span>
              )}
            </div>
            {st.isInPosition && (
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                {st.entryPrice != null && (
                  <div>
                    <div className="text-muted-foreground">Entry Price</div>
                    <div className="font-mono">${st.entryPrice.toFixed(4)}</div>
                  </div>
                )}
                {st.entryFr != null && (
                  <div>
                    <div className="text-muted-foreground">Entry FR</div>
                    <div className="font-mono text-violet-300">{(st.entryFr * 100).toFixed(4)}%</div>
                  </div>
                )}
                {st.frAccumulated != null && (
                  <div>
                    <div className="text-muted-foreground">FR Terkumpul</div>
                    <div className="font-mono text-violet-300">{(st.frAccumulated * 100).toFixed(4)}%</div>
                  </div>
                )}
                {st.entryAt && (
                  <div>
                    <div className="text-muted-foreground">Entry</div>
                    <div className="font-mono text-[10px]">
                      {new Date(st.entryAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {st?.lastCheckedAt && (
          <div className="text-xs text-muted-foreground">
            Dicek terakhir:{" "}
            <span className="font-mono">
              {new Date(st.lastCheckedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}
            </span>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-3 pb-4 border-t border-border/50 bg-background/50 flex gap-2">
        <Button
          variant={strategy.isRunning ? "destructive" : "default"}
          className={`flex-1 ${!strategy.isRunning ? "bg-violet-600 hover:bg-violet-700 text-white" : ""}`}
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
          className="w-9 shrink-0 hover:bg-sky-500/10 hover:text-sky-400 hover:border-sky-500/30"
          title="Lihat Log"
          aria-label="Lihat Log"
          onClick={onShowLog}
        >
          <ScrollText className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="w-9 shrink-0 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
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

export default function ExtendedStrategies() {
  const qc = useQueryClient();

  const { data: strategies = [], isLoading } = useExtendedStrategies();
  const { data: account, isFetching: accountFetching, refetch: refetchAccount } = useExtendedAccount();

  const startMutation = useStartExtendedBot();
  const stopMutation = useStopExtendedBot();
  const deleteMutation = useDeleteExtendedStrategy();
  const startFrArbMutation = useStartExtendedFrArb();
  const stopFrArbMutation = useStopExtendedFrArb();

  const [chartStrategy, setChartStrategy] = useState<{ id: number; name: string } | null>(null);
  const [editStrategy, setEditStrategy] = useState<ExtStrategy | null>(null);
  const [logStrategyId, setLogStrategyId] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showPositions, setShowPositions] = useState(false);
  // FE-STRAT-010: konfirmasi sebelum stop bot agar user tidak salah klik
  const [stopTarget, setStopTarget] = useState<ExtStrategy | null>(null);
  const logStrategy       = strategies.find((s) => s.id === logStrategyId);
  const regularStrategies = strategies.filter((s) => s.type !== "funding_arb");
  const frArbStrategies   = strategies.filter((s) => s.type === "funding_arb");

  const handleToggle = (strategy: ExtStrategy) => {
    // FE-STRAT-010: stop selalu lewat dialog konfirmasi; start tetap langsung (low risk)
    if (strategy.isRunning) {
      setStopTarget(strategy);
      return;
    }
    if (strategy.type === "funding_arb") {
      startFrArbMutation.mutate(strategy.id, {
        onSuccess: () => toast.success("FR Arb Bot Dimulai", { description: strategy.name }),
        onError: (err: any) => toast.error("Gagal Memulai FR Arb Bot", { description: err.message }),
      });
    } else {
      startMutation.mutate(strategy.id, {
        onSuccess: () => toast.success("Bot Extended Dimulai", { description: strategy.name }),
        onError: (err: any) =>
          toast.error("Gagal Memulai Bot", { description: err.message }),
      });
    }
  };

  const confirmStop = () => {
    if (!stopTarget) return;
    const strategy = stopTarget;
    setStopTarget(null);
    if (strategy.type === "funding_arb") {
      stopFrArbMutation.mutate(strategy.id, {
        onSuccess: () => toast.success("FR Arb Bot Dihentikan", { description: strategy.name }),
        onError: (err: any) => toast.error("Gagal Menghentikan FR Arb Bot", { description: err.message }),
      });
    } else {
      stopMutation.mutate(strategy.id, {
        onSuccess: () => toast.success("Bot Extended Dihentikan", { description: strategy.name }),
        onError: (err: any) =>
          toast.error("Gagal Menghentikan Bot", { description: err.message }),
      });
    }
  };

  const handleDelete = (strategy: ExtStrategy) => {
    if (!confirm(`Yakin ingin menghapus strategi "${strategy.name}"?`)) return;
    deleteMutation.mutate(strategy.id, {
      onSuccess: () => toast.success("Strategi Extended Dihapus"),
      onError: (err: any) =>
        toast.error("Gagal Menghapus", { description: err.message }),
    });
  };

  const isBusy = (id: number) =>
    (startMutation.isPending && (startMutation.variables as number) === id) ||
    (stopMutation.isPending && (stopMutation.variables as number) === id) ||
    (deleteMutation.isPending && (deleteMutation.variables as number) === id) ||
    (startFrArbMutation.isPending && (startFrArbMutation.variables as number) === id) ||
    (stopFrArbMutation.isPending && (stopFrArbMutation.variables as number) === id);

  const isConfigured = account?.configured ?? false;

  return (
    <div className="space-y-6 sm:space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground flex items-center gap-3">
            <ExchangeLogo exchange="extended" size={32} className="rounded-lg" />
            Strategi Extended
          </h1>
          <p className="text-muted-foreground mt-1">
            Bot trading otomatis di Extended DEX
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap w-full sm:w-auto">
          <ExtAccountWidget onClickPositions={() => setShowPositions(true)} />
          <Button
            variant="outline"
            size="sm"
            className="gap-2 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
            onClick={() => setHistoryOpen(true)}
          >
            <History className="w-4 h-4" /> Riwayat
          </Button>
          <ExtCreateStrategyModal onCreated={() => qc.invalidateQueries({ queryKey: EXT_QUERY_KEYS.strategies })} />
        </div>
      </header>

      {/* Info badge — dinamis berdasarkan konfigurasi akun */}
      <div className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg border text-sm w-fit max-w-full flex-wrap ${
        isConfigured
          ? "bg-emerald-500/5 border-emerald-500/20"
          : "bg-muted border-border"
      }`}>
        <ExchangeLogo exchange="extended" size={14} />
        <span className="text-emerald-300 font-medium">Extended DEX</span>
        {isConfigured ? (
          <span className="text-green-400 font-medium">aktif ✓</span>
        ) : (
          <span className="text-emerald-400 font-medium">belum dikonfigurasi</span>
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
          <Zap className="w-16 h-16 text-emerald-400 mb-4 opacity-20" />
          <h3 className="text-xl font-bold text-foreground">Belum Ada Strategi Extended</h3>
          <p className="text-muted-foreground mt-2 max-w-md mx-auto">
            {isConfigured
              ? 'Klik "Strategi Extended Baru" untuk membuat Grid atau FR Arb bot di Extended DEX.'
              : "Konfigurasikan kredensial Extended terlebih dahulu sebelum membuat strategi."}
          </p>
          {isConfigured && (
            <div className="flex gap-3 mt-6 flex-wrap justify-center">
              <ExtCreateStrategyModal onCreated={() => qc.invalidateQueries({ queryKey: EXT_QUERY_KEYS.strategies })} />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {regularStrategies.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {regularStrategies.map((strategy) => (
                <ExtStrategyCard
                  key={strategy.id}
                  strategy={strategy}
                  onToggle={() => handleToggle(strategy)}
                  onDelete={() => handleDelete(strategy)}
                  onShowChart={() => setChartStrategy({ id: strategy.id, name: strategy.name })}
                  onEdit={() => setEditStrategy(strategy)}
                  onShowLog={() => setLogStrategyId(strategy.id)}
                  isBusy={isBusy(strategy.id)}
                  exchangePosition={(account?.positions ?? []).find(
                    (p) => p.market === strategy.marketSymbol
                  ) ?? null}
                />
              ))}
            </div>
          )}

          {frArbStrategies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Percent className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-emerald-300 uppercase tracking-wider">
                  FR Arb Bots
                </h2>
                <span className="text-xs text-muted-foreground">({frArbStrategies.length})</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {frArbStrategies.map((strategy) => (
                  <ExtFrArbStrategyCard
                    key={strategy.id}
                    strategy={strategy}
                    onToggle={() => handleToggle(strategy)}
                    onDelete={() => handleDelete(strategy)}
                    onShowLog={() => setLogStrategyId(strategy.id)}
                    isBusy={isBusy(strategy.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {chartStrategy && (
        <ExtPnlChartDialog
          strategyId={chartStrategy.id}
          strategyName={chartStrategy.name}
          open={!!chartStrategy}
          onClose={() => setChartStrategy(null)}
        />
      )}

      <ExtEditStrategyModal
        strategy={editStrategy as any}
        viewOnly={editStrategy?.isRunning ?? false}
        onClose={() => {
          setEditStrategy(null);
          qc.invalidateQueries({ queryKey: EXT_QUERY_KEYS.strategies });
        }}
      />

      {logStrategy && (
        <ExtLogDialog
          strategyId={logStrategy.id}
          strategyName={logStrategy.name}
          open={true}
          onClose={() => setLogStrategyId(null)}
        />
      )}

      <ExtHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />

      <ExtPositionsDialog
        open={showPositions}
        onClose={() => setShowPositions(false)}
        positions={account?.positions ?? []}
        isLoading={accountFetching}
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
