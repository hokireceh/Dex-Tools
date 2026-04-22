import { useState } from "react";
import { useGetTradeHistory, getGetTradeHistoryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { History, ExternalLink, ReceiptText } from "lucide-react";
import { formatWIBDateTime } from "@/lib/utils";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { PriceDisplay } from "@/components/ui/PriceDisplay";
import { safeDec } from "@/lib/decimal";

function getExplorerUrl(exchange: string, txHash: string): string {
  if (!txHash) return "";
  switch (exchange) {
    case "lighter":
      return `https://app.lighter.xyz/explorer/logs/${txHash}`;
    case "extended":
      return "";
    default:
      return txHash;
  }
}

function SideBadge({ side }: { side: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
      side === "buy" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
    }`}>
      {side.toUpperCase()}
    </span>
  );
}

function StatusText({ status }: { status: string }) {
  const colorClass =
    status === "filled" ? "text-success" :
    status === "failed" ? "text-destructive" :
    status === "cancelled" ? "text-muted-foreground" :
    "text-warning";
  return (
    <span className={`text-xs font-medium ${colorClass}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function Trades() {
  const [limit, setLimit] = useState(50);
  const { data, isLoading } = useGetTradeHistory(
    { limit },
    { query: { queryKey: getGetTradeHistoryQueryKey({ limit }), refetchInterval: 10000 } }
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground flex items-center gap-3">
            <History className="w-6 h-6 md:w-8 md:h-8 text-primary" />
            Riwayat Trade
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">Log lengkap order yang dieksekusi dan tertunda</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Tampilkan:</span>
          <Select value={limit.toString()} onValueChange={(v) => setLimit(parseInt(v))}>
            <SelectTrigger className="w-24 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* Mobile card list — visible only on xs screens */}
      <div className="sm:hidden space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="glass-panel">
              <CardContent className="p-3 space-y-2">
                <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                <div className="h-3 w-24 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))
        ) : !data?.trades.length ? (
          <Card className="glass-panel">
            <CardContent className="py-12 flex flex-col items-center text-center gap-3">
              <ReceiptText className="w-12 h-12 text-muted-foreground opacity-20" />
              <p className="text-muted-foreground text-sm font-medium">Belum ada riwayat trade</p>
              <p className="text-xs text-muted-foreground/60">Trade akan muncul di sini setelah bot pertama kamu berjalan</p>
            </CardContent>
          </Card>
        ) : (
          data.trades.map((trade) => (
            <Card key={trade.id} className="glass-panel overflow-hidden">
              <CardContent className="p-3">
                {/* Row 1: Market + Side + Status */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <ExchangeLogo exchange={(trade.exchange as "lighter" | "extended") ?? "lighter"} size={14} />
                    <span className="font-bold text-sm text-foreground">{trade.marketSymbol}</span>
                    <SideBadge side={trade.side} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusText status={trade.status} />
                    {trade.orderHash && (() => {
                      const url = getExplorerUrl(trade.exchange ?? "", trade.orderHash ?? "");
                      return url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ) : null;
                    })()}
                  </div>
                </div>
                {/* Row 2: Time + Price */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatWIBDateTime(trade.executedAt || trade.createdAt)}
                  </span>
                  {safeDec(trade.price).gt(0) ? (
                    <PriceDisplay
                      value={safeDec(trade.price).toNumber()}
                      format="currency"
                      decimals={2}
                      maxDecimals={6}
                      colored={false}
                      className="text-xs text-foreground"
                    />
                  ) : (
                    <span className="font-mono text-xs text-foreground">MKT</span>
                  )}
                </div>
                {/* Row 3: Strategy + Size */}
                {(trade.strategyName || trade.size) && (
                  <div className="flex items-center justify-between mt-1 pt-1 border-t border-border/30">
                    <span className="text-[11px] text-muted-foreground truncate max-w-[60%]">
                      {trade.strategyName || "—"}
                    </span>
                    <PriceDisplay
                      value={safeDec(trade.size).toNumber()}
                      format="decimal"
                      decimals={6}
                      colored={false}
                      className="text-[11px] text-muted-foreground"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Desktop/tablet table — hidden on xs, visible on sm+ */}
      <Card className="glass-panel overflow-hidden hidden sm:block">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {/* FE-GLOBAL-001: min-w cegah tabel collapse di mobile sempit */}
            <Table className="min-w-[720px]">
              <TableHeader className="bg-muted/50">
                <TableRow className="border-border/50 hover:bg-transparent">
                  <TableHead className="w-[180px]">Waktu</TableHead>
                  <TableHead>Pasar</TableHead>
                  <TableHead className="hidden md:table-cell">Strategi</TableHead>
                  <TableHead>Sisi</TableHead>
                  <TableHead className="text-right">Harga</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Ukuran</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i} className="border-border/50">
                      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
                      <TableCell><div className="h-4 w-16 bg-muted animate-pulse rounded" /></TableCell>
                      <TableCell className="hidden md:table-cell"><div className="h-4 w-24 bg-muted animate-pulse rounded" /></TableCell>
                      <TableCell><div className="h-4 w-12 bg-muted animate-pulse rounded" /></TableCell>
                      <TableCell className="text-right"><div className="h-4 w-16 bg-muted animate-pulse rounded ml-auto" /></TableCell>
                      <TableCell className="text-right hidden md:table-cell"><div className="h-4 w-16 bg-muted animate-pulse rounded ml-auto" /></TableCell>
                      <TableCell className="text-right"><div className="h-4 w-16 bg-muted animate-pulse rounded ml-auto" /></TableCell>
                    </TableRow>
                  ))
                ) : !data?.trades.length ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-48 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <ReceiptText className="w-10 h-10 text-muted-foreground opacity-20" />
                        <p className="text-muted-foreground text-sm font-medium">Belum ada riwayat trade</p>
                        <p className="text-xs text-muted-foreground/60">Trade akan muncul di sini setelah bot pertama kamu berjalan</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data.trades.map((trade) => (
                    <TableRow key={trade.id} className="border-border/50 hover:bg-muted/30 transition-colors">
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {formatWIBDateTime(trade.executedAt || trade.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ExchangeLogo exchange={(trade.exchange as "lighter" | "extended") ?? "lighter"} size={14} />
                          <span className="font-bold text-foreground text-sm">{trade.marketSymbol}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {trade.strategyName}
                      </TableCell>
                      <TableCell>
                        <SideBadge side={trade.side} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {safeDec(trade.price).gt(0) ? (
                          <PriceDisplay
                            value={safeDec(trade.price).toNumber()}
                            format="currency"
                            decimals={2}
                            maxDecimals={6}
                            colored={false}
                            className="justify-end text-sm"
                          />
                        ) : (
                          "MKT"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm hidden md:table-cell">
                        <PriceDisplay
                          value={safeDec(trade.size).toNumber()}
                          format="decimal"
                          decimals={6}
                          colored={false}
                          className="justify-end text-sm"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <StatusText status={trade.status} />
                          {trade.orderHash && (() => {
                            const url = getExplorerUrl(trade.exchange ?? "", trade.orderHash ?? "");
                            return url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-primary transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            ) : null;
                          })()}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
