import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollText, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatWIBDateTime } from "@/lib/utils";

interface LighterLog {
  id: number;
  strategyId: number | null;
  strategyName: string | null;
  exchange: string;
  level: string;
  message: string;
  details: unknown | null;
  createdAt: string;
}

interface LighterLogDialogProps {
  strategyId: number;
  strategyName: string;
  open: boolean;
  onClose: () => void;
}

const LIGHTER_LOG_KEYS = {
  logs: (strategyId: number) => ["lighter-logs", strategyId] as const,
};

async function fetchLighterLogs(strategyId: number): Promise<LighterLog[]> {
  const res = await fetch(`/api/bot/logs?strategyId=${strategyId}&limit=50`, {
    credentials: "include",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any).error ?? `HTTP ${res.status}`);
  return (json as { logs: LighterLog[] }).logs ?? [];
}

function useLighterLogs(strategyId: number, enabled: boolean) {
  return useQuery({
    queryKey: LIGHTER_LOG_KEYS.logs(strategyId),
    queryFn: () => fetchLighterLogs(strategyId),
    enabled,
    staleTime: 0,
  });
}

const levelColor = (lvl: string) => {
  if (lvl === "error") return "text-destructive";
  if (lvl === "warn") return "text-yellow-400";
  if (lvl === "success") return "text-green-400";
  return "text-muted-foreground";
};

export function LighterLogDialog({ strategyId, strategyName, open, onClose }: LighterLogDialogProps) {
  const qc = useQueryClient();
  const { data: logs = [], isLoading, isFetching } = useLighterLogs(strategyId, open);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: LIGHTER_LOG_KEYS.logs(strategyId) });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[620px] bg-card border-border max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="w-5 h-5 text-teal-400" />
            Log Lighter — {strategyName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between pt-2 pb-1">
          <span className="text-xs text-muted-foreground">
            {logs.length > 0 ? `${logs.length} log terbaru` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isFetching}>
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="h-24 bg-muted animate-pulse rounded-lg" />
          ) : logs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">Belum ada log untuk strategi ini</p>
          ) : (
            <div className="space-y-1 text-xs font-mono">
              {logs.map((log, i) => (
                <div key={log.id ?? i} className="flex gap-2 items-start py-0.5 border-b border-border/20 last:border-0">
                  <span className="text-muted-foreground shrink-0 w-36">
                    {formatWIBDateTime(log.createdAt)}
                  </span>
                  <span className={`shrink-0 font-bold w-14 ${levelColor(log.level)}`}>
                    [{log.level.toUpperCase().slice(0, 5)}]
                  </span>
                  <span className="flex-1 text-foreground/80 break-all">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
