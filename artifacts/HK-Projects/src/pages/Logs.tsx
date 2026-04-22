import { useEffect, useRef, useState, useMemo } from "react";
import { useGetBotLogs, getGetBotLogsQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal, Copy, Check } from "lucide-react";
import { formatWIBDateTime } from "@/lib/utils";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";

type LogLevel = "all" | "error" | "warn" | "info";
type ExchangeFilter = "all" | "lighter" | "extended";

const LEVEL_FILTERS: { value: LogLevel; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "error", label: "ERROR" },
  { value: "warn", label: "WARN" },
  { value: "info", label: "INFO" },
];

const EXCHANGE_FILTERS: { value: ExchangeFilter; label: string }[] = [
  { value: "all", label: "Semua DEX" },
  { value: "lighter", label: "Lighter" },
  { value: "extended", label: "Extended" },
];

interface UnifiedLog {
  key: string;
  id: number;
  exchange: "lighter" | "extended";
  strategyName: string | null;
  level: string;
  message: string;
  details: string | null;
  createdAt: string;
}

interface RawLogEntry {
  id: number;
  strategyName?: string | null;
  level: string;
  message: string;
  details?: string | null;
  createdAt: string;
}

function mapRawToUnified(raw: RawLogEntry, exchange: UnifiedLog["exchange"]): UnifiedLog {
  return {
    key: `${exchange}-${raw.id}`,
    id: raw.id,
    exchange,
    strategyName: raw.strategyName ?? null,
    level: raw.level,
    message: raw.message,
    details: raw.details ?? null,
    createdAt: raw.createdAt,
  };
}

async function fetchExtendedLogs(limit: number): Promise<UnifiedLog[]> {
  const res = await fetch(`/api/extended/strategies/logs/recent?limit=${limit}`, { credentials: "include" });
  if (!res.ok) return [];
  const json = await res.json() as { logs?: RawLogEntry[] };
  return (json.logs ?? []).map((l) => mapRawToUnified(l, "extended"));
}

export default function Logs() {
  const { data: lighterData, isLoading: loadingLighter } = useGetBotLogs(
    { limit: 200 },
    { query: { queryKey: getGetBotLogsQueryKey({ limit: 200 }), refetchInterval: 5000 } }
  );

  const { data: extendedLogs = [], isLoading: loadingExtended } = useQuery<UnifiedLog[]>({
    queryKey: ["extended-logs-full", 200],
    queryFn: () => fetchExtendedLogs(200),
    refetchInterval: 5000,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [copied, setCopied] = useState(false);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<LogLevel>("all");
  const [exchangeFilter, setExchangeFilter] = useState<ExchangeFilter>("all");

  const isLoading = loadingLighter || loadingExtended;

  const allLogs = useMemo<UnifiedLog[]>(() => {
    const lighter: UnifiedLog[] = (lighterData?.logs ?? []).map((l) => ({
      key: `lighter-${l.id}`,
      id: l.id ?? 0,
      exchange: "lighter" as const,
      strategyName: l.strategyName ?? null,
      level: l.level,
      message: l.message,
      details: l.details ?? null,
      createdAt: l.createdAt,
    }));
    return [...lighter, ...extendedLogs]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [lighterData, extendedLogs]);

  const logs = useMemo(() => {
    return allLogs.filter((l) => {
      const levelMatch = levelFilter === "all"
        ? true
        : levelFilter === "info"
          ? (l.level === "info" || l.level === "success")
          : l.level === levelFilter;
      const exchangeMatch = exchangeFilter === "all" ? true : l.exchange === exchangeFilter;
      return levelMatch && exchangeMatch;
    });
  }, [allLogs, levelFilter, exchangeFilter]);

  const handleCopyAll = () => {
    if (!logs.length) return;
    const text = logs.map((log) => {
      const ts = `[${formatWIBDateTime(log.createdAt)}]`;
      const level = log.level.toUpperCase().padEnd(7);
      const exchange = log.exchange.toUpperCase().padEnd(8);
      const name = (log.strategyName || "SYSTEM").padEnd(20);
      const msg = log.details ? `${log.message}\n  ${log.details}` : log.message;
      return `${ts} ${level} ${exchange} ${name} ${msg}`;
    }).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCopyRow = (log: UnifiedLog) => {
    const ts = `[${formatWIBDateTime(log.createdAt)}]`;
    const level = log.level.toUpperCase().padEnd(7);
    const exchange = log.exchange.toUpperCase().padEnd(8);
    const name = (log.strategyName || "SYSTEM").padEnd(20);
    const msg = log.details ? `${log.message}  ${log.details}` : log.message;
    const text = `${ts} ${level} ${exchange} ${name} ${msg}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedRowId(log.key);
      setTimeout(() => setCopiedRowId(null), 1500);
    });
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    userScrolledUp.current = !isAtBottom;
  };

  useEffect(() => {
    if (userScrolledUp.current) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    });
  }, [logs.length]);

  return (
    <div className="space-y-6 h-[calc(100dvh-10rem-var(--safe-bottom))] min-h-[28rem] md:h-[calc(100vh-8rem)] flex flex-col animate-in fade-in duration-500">
      <header>
        <h1 className="text-2xl md:text-3xl font-bold text-foreground flex items-center gap-3">
          <Terminal className="w-6 h-6 md:w-8 md:h-8 text-primary" />
          Log Sistem
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">Eksekusi bot real-time — Lighter &amp; Extended DEX</p>
      </header>

      <Card className="glass-panel flex-1 overflow-hidden flex flex-col border-border/50">
        <div className="bg-muted px-3 py-2 border-b border-border/50 flex flex-wrap justify-between items-center shrink-0 gap-2">
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="w-2.5 h-2.5 rounded-full bg-destructive" />
            <div className="w-2.5 h-2.5 rounded-full bg-warning" />
            <div className="w-2.5 h-2.5 rounded-full bg-success" />
          </div>

          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <div className="flex items-center gap-1 overflow-x-auto max-w-full">
              {LEVEL_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[10px] font-mono ${
                    levelFilter === f.value
                      ? "bg-white/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  } ${
                    f.value === "error" && levelFilter === f.value ? "text-destructive" :
                    f.value === "warn" && levelFilter === f.value ? "text-warning" :
                    f.value === "info" && levelFilter === f.value ? "text-blue-400" : ""
                  }`}
                  onClick={() => setLevelFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-1 border-l border-border/50 pl-2 overflow-x-auto max-w-full">
              {EXCHANGE_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[10px] font-mono ${
                    exchangeFilter === f.value
                      ? "bg-white/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setExchangeFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </div>

          <button
            onClick={handleCopyAll}
            className="flex items-center gap-1 text-[10px] sm:text-xs font-mono text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-white/10 shrink-0"
            title="Salin semua log"
            aria-label="Salin semua log"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            <span className="hidden xs:inline">{copied ? "Tersalin!" : "Salin"}</span>
          </button>
        </div>

        <CardContent className="p-0 flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto bg-black/50 font-mono text-xs"
          >
            {isLoading ? (
              <div className="p-4 text-muted-foreground animate-pulse">Memuat log...</div>
            ) : !logs.length ? (
              <div className="p-4 text-muted-foreground">Belum ada log.</div>
            ) : (
              <div className="p-2 sm:p-4 space-y-0.5">
                {logs.map((log) => {
                  let colorClass = "text-muted-foreground";
                  if (log.level === "error") colorClass = "text-destructive font-semibold";
                  if (log.level === "success") colorClass = "text-success";
                  if (log.level === "warn") colorClass = "text-warning";
                  if (log.level === "info") colorClass = "text-blue-400";

                  return (
                    <div
                      key={log.key}
                      className="group hover:bg-white/5 px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                      onClick={() => handleCopyRow(log)}
                      title="Klik untuk menyalin baris ini"
                    >
                      <div className="flex items-center gap-2 sm:hidden">
                        <ExchangeLogo exchange={log.exchange} size={12} />
                        <span className={`shrink-0 uppercase text-[10px] font-bold w-8 ${colorClass}`}>
                          {log.level.slice(0, 4)}
                        </span>
                        <span className="text-muted-foreground text-[10px] truncate">
                          {formatWIBDateTime(log.createdAt)}
                        </span>
                        <span className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground">
                          {copiedRowId === log.key
                            ? <Check className="w-3 h-3 text-success" />
                            : <Copy className="w-3 h-3" />}
                        </span>
                      </div>
                      <div className={`sm:hidden pl-10 break-words ${colorClass}`}>
                        {log.message}
                        {log.details && (
                          <span className="block text-muted-foreground font-normal opacity-75 mt-0.5">
                            {log.details}
                          </span>
                        )}
                      </div>

                      <div className="hidden sm:flex gap-3 items-start">
                        <span className="text-muted-foreground shrink-0 w-44 whitespace-nowrap">
                          [{formatWIBDateTime(log.createdAt)}]
                        </span>
                        <span className={`shrink-0 w-14 uppercase ${colorClass}`}>
                          {log.level}
                        </span>
                        <span className="shrink-0 w-6 flex items-center pt-0.5">
                          <ExchangeLogo exchange={log.exchange} size={12} />
                        </span>
                        <span className="shrink-0 w-32 text-primary truncate">
                          {log.strategyName || (log.exchange === "lighter" ? "Sistem Lighter" : "Sistem Extended")}
                        </span>
                        <span className={`flex-1 min-w-0 break-words ${colorClass}`}>
                          {log.message}
                          {log.details && (
                            <span className="block text-muted-foreground font-normal mt-0.5 opacity-75">
                              {log.details}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground flex items-start pt-0.5">
                          {copiedRowId === log.key
                            ? <Check className="w-3 h-3 text-success" />
                            : <Copy className="w-3 h-3" />}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
