import { useState, useEffect, useMemo, useRef } from "react";
import { safeDec, sumDec } from "@/lib/decimal";
import { toast } from "sonner";
import {
  useGetAccountInfo,
  useGetStrategies,
  useGetBotLogs,
  getGetBotLogsQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PriceDisplay } from "@/components/ui/PriceDisplay";
import {
  Wallet, Activity, ArrowRightLeft, TrendingUp, AlertTriangle, Clock, Zap, ExternalLink,
} from "lucide-react";
import { Link } from "wouter";
import { formatWIBTime } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";

// ── Tipe Extended ─────────────────────────────────────────────────────────────

interface ExtStrategy { id: number; name: string; type: string; marketSymbol: string; isRunning: boolean; }

interface ExtAccountData {
  configured: boolean;
  network?: string;
  balance?: {
    equity: number;
    availableForTrade: number;
    unrealisedPnl: number;
    marginRatio: number;
    collateralName: string;
  } | null;
  positions?: Array<{
    id: number;
    market: string;
    side: "LONG" | "SHORT";
    size: string;
    openPrice: number;
    markPrice: number;
    unrealisedPnl: number;
    realisedPnl: number;
    leverage: string;
    liquidationPrice: number;
  }>;
}

interface UnifiedLog {
  key: string;
  exchange: "lighter" | "extended";
  strategyName: string | null;
  level: string;
  message: string;
  details: string | null;
  createdAt: string;
}

// FE-DASHBOARD-003: stop swallowing fetch errors silently.
// One-shot hooks toast on every failure (always "initial").
// Polling hooks toast only on the first failure to avoid spam every interval tick;
// subsequent failures still console.warn for DevTools traceability.
function handleFetchError(err: unknown, label: string, isInitial: boolean) {
  console.warn(`[Dashboard] gagal memuat ${label}:`, err);
  if (isInitial) toast.error(`Gagal memuat ${label}`);
}

// FE-DASHBOARD-001: AbortError harus disuppress (cleanup unmount fires controller.abort()
// → fetch reject dengan AbortError, bukan kegagalan jaringan).
function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useExtendedStrategies() {
  const [data, setData] = useState<ExtStrategy[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/extended/strategies", { credentials: "include", signal: ac.signal })
      .then(r => r.ok ? r.json() : { strategies: [] })
      .then(json => { if (!ac.signal.aborted) setData(json.strategies ?? []); })
      .catch(err => {
        if (isAbortError(err)) return;
        handleFetchError(err, "strategi Extended", true);
        if (!ac.signal.aborted) setData([]);
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);
  return { data, loading };
}

function useExtendedAccount() {
  const [data, setData] = useState<ExtAccountData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/extended/strategies/account", { credentials: "include", signal: ac.signal })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (!ac.signal.aborted) setData(json); })
      .catch(err => {
        if (isAbortError(err)) return;
        handleFetchError(err, "saldo Extended", true);
        if (!ac.signal.aborted) setData(null);
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);
  return { data, loading };
}

function useExtendedLogs(limit = 8) {
  const [data, setData] = useState<Array<{ id: number; strategyName: string | null; level: string; message: string; details: string | null; createdAt: string }> | null>(null);
  const [loading, setLoading] = useState(true);
  const isInitialRef = useRef(true);

  useEffect(() => {
    const ac = new AbortController();
    const fetchLogs = () => {
      fetch(`/api/extended/strategies/logs/recent?limit=${limit}`, { credentials: "include", signal: ac.signal })
        .then(r => r.ok ? r.json() : { logs: [] })
        .then(json => { if (!ac.signal.aborted) setData(json.logs ?? []); })
        .catch(err => {
          if (isAbortError(err)) return;
          handleFetchError(err, "log Extended", isInitialRef.current);
          if (!ac.signal.aborted) setData([]);
        })
        .finally(() => { if (!ac.signal.aborted) { setLoading(false); isInitialRef.current = false; } });
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => { ac.abort(); clearInterval(interval); };
  }, [limit]);

  return { data, loading };
}



// ── Subkomponen Extended Section (tanpa log) ──────────────────────────────────

function ExtendedSection({
  strategies,
  loadingStrategies,
  account,
  loadingAccount,
}: {
  strategies: ExtStrategy[] | null;
  loadingStrategies: boolean;
  account: ExtAccountData | null;
  loadingAccount: boolean;
}) {
  const extRunning = strategies?.filter(s => s.isRunning) ?? [];
  const extTotal = strategies?.length ?? 0;
  const notConfigured = !loadingAccount && account && !account.configured;
  const positions = account?.positions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ExchangeLogo exchange="extended" size={18} />
        <h2 className="text-lg font-semibold text-foreground">Extended DEX</h2>
        {account?.network && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
            {account.network}
          </span>
        )}
        <Link
          href="/extended"
          className="ml-auto text-sm text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
        >
          Kelola <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {notConfigured ? (
        <Card className="glass-panel glass-card-extended border-emerald-500/10">
          <CardContent className="py-6">
            <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
              <Zap className="w-8 h-8 text-emerald-400 opacity-30" />
              <p className="text-sm">API Key Extended belum dikonfigurasi.</p>
              <Link href="/extended-config" className="text-emerald-400 hover:underline text-sm">
                Konfigurasi sekarang →
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="glass-panel glass-card-extended hover:-translate-y-1 transition-transform duration-300 border-emerald-500/10">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Ekuitas Extended</CardTitle>
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Wallet className="w-4 h-4 text-emerald-400" />
                </div>
              </CardHeader>
              <CardContent>
                {loadingAccount ? (
                  <div className="h-8 w-24 bg-muted animate-pulse rounded" />
                ) : account?.balance ? (
                  <>
                    <PriceDisplay value={account.balance.equity} format="currency" colored={false} className="text-2xl font-bold text-foreground" />
                    <p className="text-xs text-muted-foreground mt-1">Tersedia: ${account.balance.availableForTrade.toFixed(2)}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </CardContent>
            </Card>

            <Card className="glass-panel glass-card-extended hover:-translate-y-1 transition-transform duration-300 border-emerald-500/10">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Bot Extended Aktif</CardTitle>
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Activity className="w-4 h-4 text-emerald-400" />
                </div>
              </CardHeader>
              <CardContent>
                {loadingStrategies ? (
                  <div className="h-8 w-16 bg-muted animate-pulse rounded" />
                ) : (
                  <div className="text-2xl font-bold text-foreground font-mono">
                    {extRunning.length}{" "}
                    <span className="text-muted-foreground text-sm font-sans font-normal">/ {extTotal}</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">Strategi dikonfigurasi</p>
              </CardContent>
            </Card>

            <Card className="glass-panel glass-card-extended hover:-translate-y-1 transition-transform duration-300 border-emerald-500/10">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Posisi Extended</CardTitle>
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
                </div>
              </CardHeader>
              <CardContent>
                {loadingAccount ? (
                  <div className="h-8 w-16 bg-muted animate-pulse rounded" />
                ) : (
                  <div className="text-2xl font-bold text-foreground font-mono">{positions.length}</div>
                )}
                <p className="text-xs text-muted-foreground mt-1">Posisi terbuka</p>
              </CardContent>
            </Card>

            <Card className="glass-panel glass-card-extended hover:-translate-y-1 transition-transform duration-300 border-emerald-500/10">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">PnL Belum Terealisasi</CardTitle>
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                </div>
              </CardHeader>
              <CardContent>
                {loadingAccount ? (
                  <div className="h-8 w-24 bg-muted animate-pulse rounded" />
                ) : account?.balance ? (
                  <>
                    <PriceDisplay value={account.balance.unrealisedPnl} format="currency" showIcon className="text-2xl font-bold" />
                    {account.balance.marginRatio > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">Margin ratio: {(account.balance.marginRatio * 100).toFixed(2)}%</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Posisi terbuka Extended */}
          <Card className="glass-panel glass-card-extended border-emerald-500/10">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ExchangeLogo exchange="extended" size={14} />
                Posisi Terbuka Extended
              </CardTitle>
              <CardDescription>Eksposur risiko di Extended DEX</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingAccount ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <div key={i} className="h-12 bg-muted animate-pulse rounded-lg" />)}
                </div>
              ) : positions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground flex flex-col items-center">
                  <AlertTriangle className="w-8 h-8 mb-2 opacity-20" />
                  <p>Tidak ada posisi terbuka di Extended.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {positions.map(pos => (
                    <div key={pos.id} className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50 hover:border-emerald-500/30 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`px-2 py-1 rounded text-xs font-bold ${pos.side === "LONG" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"}`}>
                          {pos.side}
                        </div>
                        <div>
                          <div className="font-bold text-foreground font-mono">{pos.market}</div>
                          <div className="text-xs text-muted-foreground font-mono">{pos.size} @ ${Number(pos.openPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} · {pos.leverage}x</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <PriceDisplay value={pos.unrealisedPnl} format="currency" showIcon />
                        <div className="text-xs text-muted-foreground font-mono">Mark: ${Number(pos.markPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Dashboard utama ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuth();
  const { data: account, isLoading: loadingAccount } = useGetAccountInfo();
  const { data: strategiesData, isLoading: loadingStrategies } = useGetStrategies();
  const { data: logsData, isLoading: loadingLighterLogs } = useGetBotLogs({ limit: 8 }, { query: { queryKey: getGetBotLogsQueryKey({ limit: 8 }), refetchInterval: 5000 } });

  const { data: extStrategies, loading: loadingExtStrategies } = useExtendedStrategies();
  const { data: extAccount, loading: loadingExtAccount } = useExtendedAccount();
  const { data: extLogs, loading: loadingExtLogs } = useExtendedLogs(8);

  const activeStrategies = strategiesData?.strategies?.filter(s => s.isActive) || [];
  const runningStrategies = strategiesData?.strategies?.filter(s => s.isRunning) || [];

  const expiresAt = user?.expiresAt ? new Date(user.expiresAt) : null;
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86400000) : null;
  const isExpiringSoon = daysLeft !== null && daysLeft <= 7;
  const isExpired = daysLeft !== null && daysLeft <= 0;

  // Gabungkan log Lighter + Extended, urutkan dari terbaru, ambil 10 teratas
  const loadingCombinedLogs = loadingLighterLogs || loadingExtLogs;
  const combinedLogs = useMemo<UnifiedLog[]>(() => {
    const lighter: UnifiedLog[] = (logsData?.logs ?? [])
      .map((l, i) => ({
        key: `lighter-${l.id ?? i}`,
        exchange: "lighter" as const,
        strategyName: l.strategyName ?? null,
        level: l.level,
        message: l.message,
        details: l.details ?? null,
        createdAt: l.createdAt,
      }));
    const extended: UnifiedLog[] = (extLogs ?? []).map((l, i) => ({
      key: `extended-${l.id ?? i}`,
      exchange: "extended" as const,
      strategyName: l.strategyName ?? null,
      level: l.level,
      message: l.message,
      details: l.details ?? null,
      createdAt: l.createdAt,
    }));
    return [...lighter, ...extended]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
  }, [logsData, extLogs]);

  return (
    <div className="space-y-10 animate-in fade-in duration-500">

      {/* ── Lighter Section ─────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ExchangeLogo exchange="lighter" size={18} />
          <h2 className="text-lg font-semibold text-foreground">Lighter DEX</h2>
          {account?.network && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-mono">
              {account.network}
            </span>
          )}
          <Link
            href="/lighter"
            className="ml-auto text-sm text-primary hover:text-primary/80 flex items-center gap-1"
          >
            Kelola <ExternalLink className="w-3 h-3" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="glass-panel glass-card-lighter hover:-translate-y-1 transition-transform duration-300 border-blue-500/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Ekuitas Lighter</CardTitle>
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Wallet className="w-4 h-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              {loadingAccount ? (
                <div className="h-8 w-24 bg-muted animate-pulse rounded" />
              ) : (
                <PriceDisplay value={account?.totalEquity || 0} format="currency" colored={false} className="text-2xl font-bold text-foreground" />
              )}
              <p className="text-xs text-muted-foreground mt-1">Tersedia: ${account?.availableBalance?.toFixed(2) || "0.00"}</p>
            </CardContent>
          </Card>

          <Card className="glass-panel glass-card-lighter hover:-translate-y-1 transition-transform duration-300 border-blue-500/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Bot Lighter Aktif</CardTitle>
              <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                <Activity className="w-4 h-4 text-accent" />
              </div>
            </CardHeader>
            <CardContent>
              {loadingStrategies ? (
                <div className="h-8 w-16 bg-muted animate-pulse rounded" />
              ) : (
                <div className="text-2xl font-bold text-foreground font-mono">
                  {runningStrategies.length}{" "}
                  <span className="text-muted-foreground text-sm font-sans font-normal">/ {activeStrategies.length}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Strategi dikonfigurasi</p>
            </CardContent>
          </Card>

          <Card className="glass-panel glass-card-lighter hover:-translate-y-1 transition-transform duration-300 border-blue-500/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Posisi Lighter</CardTitle>
              <div className="w-8 h-8 rounded-full bg-success/10 flex items-center justify-center">
                <ArrowRightLeft className="w-4 h-4 text-success" />
              </div>
            </CardHeader>
            <CardContent>
              {loadingAccount ? (
                <div className="h-8 w-16 bg-muted animate-pulse rounded" />
              ) : (
                <div className="text-2xl font-bold text-foreground font-mono">{account?.positions?.length || 0}</div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Di semua pasar</p>
            </CardContent>
          </Card>

          <Card className="glass-panel glass-card-lighter hover:-translate-y-1 transition-transform duration-300 border-blue-500/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">PnL Belum Terealisasi</CardTitle>
              <div className="w-8 h-8 rounded-full bg-warning/10 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-warning" />
              </div>
            </CardHeader>
            <CardContent>
              {loadingAccount ? (
                <div className="h-8 w-24 bg-muted animate-pulse rounded" />
              ) : (
                <PriceDisplay
                  value={account?.positions?.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0) || 0}
                  format="currency"
                  showIcon
                  className="text-2xl font-bold"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">Dari posisi terbuka</p>
            </CardContent>
          </Card>
        </div>

        {/* Posisi terbuka Lighter */}
        <Card className="glass-panel glass-card-lighter border-blue-500/10">
          <CardHeader>
            <CardTitle>Posisi Terbuka Lighter</CardTitle>
            <CardDescription>Eksposur risiko saat ini di Lighter</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingAccount ? (
              <div className="space-y-4">
                {[1, 2].map(i => <div key={i} className="h-12 bg-muted animate-pulse rounded-lg" />)}
              </div>
            ) : !account?.positions?.length ? (
              <div className="text-center py-8 text-muted-foreground flex flex-col items-center">
                <AlertTriangle className="w-8 h-8 mb-2 opacity-20" />
                <p>Tidak ada posisi terbuka.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {account.positions.map((pos, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50 hover:border-primary/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`px-2 py-1 rounded text-xs font-bold ${pos.side === "long" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"}`}>
                        {pos.side.toUpperCase()}
                      </div>
                      <div>
                        <div className="font-bold text-foreground">{pos.marketSymbol}</div>
                        <div className="text-xs text-muted-foreground font-mono">{pos.size} @ ${Number(pos.entryPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <PriceDisplay value={pos.unrealizedPnl} format="currency" showIcon />
                      <div className="text-xs text-muted-foreground font-mono">Mark: ${Number(pos.markPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Extended Section ─────────────────────────────────────────────────── */}
      <section>
        <ExtendedSection
          strategies={extStrategies}
          loadingStrategies={loadingExtStrategies}
          account={extAccount}
          loadingAccount={loadingExtAccount}
        />
      </section>

      {/* ── Aktivitas Terbaru (gabungan semua DEX) ────────────────────────────── */}
      <section>
        <Card className="glass-panel border-border/50">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle>Aktivitas Terbaru</CardTitle>
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success/15 border border-success/30 text-[10px] font-bold text-success uppercase tracking-wide">
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    Live
                  </span>
                </div>
                <CardDescription>Log terkini dari semua bot — Lighter &amp; Extended</CardDescription>
              </div>
            </div>
            <Link href="/logs" className="text-sm text-primary hover:text-primary/80">Lihat semua</Link>
          </CardHeader>
          <CardContent>
            {loadingCombinedLogs ? (
              <div className="space-y-4">
                {[1, 2, 3, 4].map(i => <div key={i} className="h-10 bg-muted animate-pulse rounded-lg" />)}
              </div>
            ) : combinedLogs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>Belum ada aktivitas bot.</p>
              </div>
            ) : (
              <div className="space-y-1">
                {combinedLogs.map(log => (
                  <div key={log.key} className="flex gap-3 text-sm px-2 py-2 rounded-lg hover:bg-muted/50 transition-colors">
                    {/* Level dot */}
                    <div className="shrink-0 mt-2.5">
                      {log.level === "info" && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                      {log.level === "success" && <div className="w-2 h-2 rounded-full bg-success" />}
                      {log.level === "warn" && <div className="w-2 h-2 rounded-full bg-warning" />}
                      {log.level === "error" && <div className="w-2 h-2 rounded-full bg-destructive" />}
                    </div>
                    {/* Exchange badge */}
                    <div className="shrink-0 mt-1">
                      <ExchangeLogo exchange={log.exchange} size={14} />
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline gap-2">
                        <span className="font-medium text-foreground truncate">
                          {log.strategyName || (log.exchange === "lighter" ? "Sistem Lighter DEX" : "Sistem Extended")}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0 font-mono">
                          {formatWIBTime(log.createdAt)}
                        </span>
                      </div>
                      <p className="text-muted-foreground text-xs mt-0.5 truncate">{log.message}</p>
                      {log.details && (
                        <p className="text-muted-foreground/60 text-xs mt-0.5 truncate">{log.details}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Status langganan ─────────────────────────────────────────────────── */}
      {user && (
        <div className={`rounded-xl px-4 py-3 flex items-center gap-3 text-sm border ${
          isExpired
            ? "bg-destructive/10 border-destructive/30 text-destructive"
            : isExpiringSoon
            ? "bg-warning/10 border-warning/30 text-warning"
            : "bg-success/10 border-success/30 text-success"
        }`}>
          <Clock className="w-4 h-4 shrink-0" />
          <div className="flex-1">
            <span className="font-semibold">
              {isExpired ? "Langganan Habis" : `Langganan aktif — paket ${user.plan}`}
            </span>
            {expiresAt && (
              <span className="ml-2 font-normal opacity-80">
                {isExpired
                  ? `Kadaluarsa ${expiresAt.toLocaleDateString("id-ID")}`
                  : `Kadaluarsa ${expiresAt.toLocaleDateString("id-ID")} (${daysLeft} hari lagi)`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
