import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, Users, Plus, RefreshCw, Trash2, Calendar, Shield, Monitor, CreditCard, Megaphone, TrendingUp, Send, XCircle, Clock, CheckCircle2, Ban, History, Bold, Italic, Underline, Strikethrough, Code, Link, Eye, EyeOff, Search, Play, Square, Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { formatWIBDate } from "@/lib/utils";

interface AdminUser {
  id: number;
  telegramId: string;
  telegramUsername: string | null;
  telegramName: string | null;
  password: string;
  plan: string;
  expiresAt: string;
  isActive: boolean;
  isExpired: boolean;
  createdAt: string;
}

interface AdminStrategy {
  id: number;
  name: string;
  type: string;
  exchange: "lighter" | "extended";
  marketSymbol: string;
  isActive: boolean;
  isRunning: boolean;
  realizedPnl: number;
  livePnl: number | null;
  livePnlSource: "exchange" | null;
  totalOrders: number;
  successfulOrders: number;
  updatedAt: string;
  user: { id: number; telegramName: string | null; telegramUsername: string | null; telegramId: string } | null;
}

interface AdminPayment {
  id: number;
  donationId: string;
  telegramId: string;
  telegramName: string;
  telegramUsername: string | null;
  plan: string;
  amount: number;
  expiresAt: string;
  createdAt: string;
}

const PLAN_LABELS: Record<string, string> = { "30d": "30 Hari", "60d": "60 Hari", "90d": "90 Hari" };

const EXCHANGE_BADGE: Record<string, { label: string; className: string }> = {
  lighter:  { label: "Lighter",  className: "bg-teal-500/15 text-teal-400 border-teal-500/30" },
  extended: { label: "Extended", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
};

// ─── Broadcast types ─────────────────────────────────────────────────────────
interface BroadcastJob {
  id: string;
  message: string;
  parseMode: "HTML" | "MarkdownV2" | "Markdown";
  targetFilter: "all" | "active";
  status: "pending" | "running" | "completed" | "cancelled" | "failed" | "idle";
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  lastErrors: { chatId: string; error: string }[];
  circuitBreakerState: "closed" | "open" | "half-open";
}

// ─── HTML Format Toolbar Helper ───────────────────────────────────────────────
function wrapSelected(textarea: HTMLTextAreaElement, open: string, close: string, setMsg: (v: string) => void) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const selected = val.slice(start, end) || "teks";
  const newVal = val.slice(0, start) + open + selected + close + val.slice(end);
  setMsg(newVal);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(start + open.length, start + open.length + selected.length);
  }, 0);
}

export default function Admin() {
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [strategies, setStrategies] = useState<AdminStrategy[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<"all" | "aktif" | "nonaktif">("all");

  const [newTelegramId, setNewTelegramId] = useState("");
  const [newTelegramName, setNewTelegramName] = useState("");
  const [newPlan, setNewPlan] = useState("30d");
  const [addLoading, setAddLoading] = useState(false);

  const [extendId, setExtendId] = useState<number | null>(null);
  const [extendDays, setExtendDays] = useState("30");

  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcastParseMode, setBroadcastParseMode] = useState<"HTML" | "MarkdownV2">("HTML");
  const [broadcastTargetFilter, setBroadcastTargetFilter] = useState<"all" | "active">("active");
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastJobId, setBroadcastJobId] = useState<string | null>(null);
  const [broadcastJob, setBroadcastJob] = useState<BroadcastJob | null>(null);
  const [broadcastHistory, setBroadcastHistory] = useState<BroadcastJob[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const broadcastTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [busyBotIds, setBusyBotIds] = useState<Set<number>>(new Set());
  const [confirmStop, setConfirmStop] = useState<AdminStrategy | null>(null);

  function authHeaders() {
    return { Authorization: `Bearer ${adminPassword}`, "Content-Type": "application/json" };
  }

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    const res = await fetch("/api/admin/users", { headers: authHeaders() });
    if (res.ok) {
      setIsAuthenticated(true);
      const data = await res.json();
      setUsers(data.users ?? []);
    } else {
      setAuthError("Password admin salah");
    }
  }

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/users", { headers: authHeaders() });
      if (!res.ok) throw new Error("Unauthorized");
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [adminPassword]);

  const fetchStrategies = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/all-strategies", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setStrategies(data.strategies ?? []);
    } catch { }
  }, [adminPassword]);

  const fetchPayments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/payments", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setPayments(data.payments ?? []);
    } catch { }
  }, [adminPassword]);

  const handleBotAction = useCallback(async (strategy: AdminStrategy, action: "start" | "stop") => {
    setBusyBotIds((prev) => new Set(prev).add(strategy.id));
    try {
      const res = await fetch(`/api/admin/bot/${action}/${strategy.id}`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        alert(json.error ?? `Gagal ${action === "stop" ? "menghentikan" : "memulai"} bot`);
        return;
      }
      await fetchStrategies();
    } catch {
      alert("Terjadi kesalahan jaringan");
    } finally {
      setBusyBotIds((prev) => { const s = new Set(prev); s.delete(strategy.id); return s; });
    }
  }, [adminPassword, fetchStrategies]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchStrategies();
      fetchPayments();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = setInterval(() => {
      fetchStrategies();
    }, 30_000);
    return () => clearInterval(id);
  }, [isAuthenticated, fetchStrategies]);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ telegramId: newTelegramId, telegramName: newTelegramName, plan: newPlan }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Gagal menambah user");
      setNewTelegramId(""); setNewTelegramName(""); setNewPlan("30d");
      await fetchUsers();
    } catch (e: any) { setError(e.message); } finally { setAddLoading(false); }
  }

  async function deactivateUser(id: number) {
    await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: authHeaders() });
    await fetchUsers();
  }

  async function permanentDeleteUser(id: number) {
    await fetch(`/api/admin/users/${id}?permanent=true`, { method: "DELETE", headers: authHeaders() });
    setConfirmDeleteId(null);
    await fetchUsers();
  }

  async function extendUser(id: number) {
    const days = parseInt(extendDays);
    if (!days || days <= 0) return;
    await fetch(`/api/admin/users/${id}`, {
      method: "PUT", headers: authHeaders(),
      body: JSON.stringify({ extendDays: days }),
    });
    setExtendId(null);
    await fetchUsers();
  }

  async function resetPassword(id: number) {
    await fetch(`/api/admin/users/${id}`, {
      method: "PUT", headers: authHeaders(),
      body: JSON.stringify({ resetPassword: true }),
    });
    await fetchUsers();
  }

  // ── Poll broadcast job status ─────────────────────────────────────────────
  useEffect(() => {
    if (!broadcastJobId || !isAuthenticated) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/admin/broadcast/status/${broadcastJobId}`, { headers: authHeaders() });
        if (!res.ok) return;
        const job: BroadcastJob = await res.json();
        setBroadcastJob(job);
        if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
          setBroadcastLoading(false);
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 1500);
    return () => clearInterval(iv);
  }, [broadcastJobId, isAuthenticated]);

  // ── Fetch broadcast history ────────────────────────────────────────────────
  const fetchBroadcastHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/broadcast/history", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setBroadcastHistory(data.jobs ?? []);
    } catch {}
  }, [adminPassword]);

  async function handleBroadcast(e: React.FormEvent) {
    e.preventDefault();
    if (!broadcastMsg.trim()) return;
    setBroadcastLoading(true);
    setBroadcastJob(null);
    setBroadcastJobId(null);
    try {
      const res = await fetch("/api/admin/broadcast", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          message: broadcastMsg,
          parseMode: broadcastParseMode,
          disableWebPagePreview: true,
          targetFilter: broadcastTargetFilter,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBroadcastJobId(data.jobId);
      setBroadcastMsg("");
    } catch (e: any) {
      setError(e.message);
      setBroadcastLoading(false);
    }
  }

  async function handleCancelBroadcast() {
    if (!broadcastJobId) return;
    try {
      await fetch("/api/admin/broadcast/cancel", {
        method: "DELETE", headers: authHeaders(),
        body: JSON.stringify({ jobId: broadcastJobId }),
      });
    } catch {}
  }

  function insertFormat(open: string, close: string) {
    if (broadcastTextareaRef.current) {
      wrapSelected(broadcastTextareaRef.current, open, close, setBroadcastMsg);
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-3">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-2xl flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #0fd4aa 0%, #0aaa88 100%)" }}>
                <TrendingUp className="h-9 w-9 text-white" strokeWidth={2.5} />
              </div>
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Hokireceh</h1>
              <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mt-1">Projects</p>
            </div>
            <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 w-fit mx-auto">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="text-[11px] font-semibold text-emerald-400">Lighter DEX</span>
            </div>
          </div>

          <Card className="w-full">
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-xl flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Admin Panel
              </CardTitle>
              <CardDescription>Masukkan password admin untuk melanjutkan.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label>Admin Password</Label>
                  <div className="relative">
                    <Input
                      type={showAdminPassword ? "text" : "password"}
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      className="pr-10"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowAdminPassword(!showAdminPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showAdminPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {authError && (
                  <div className="flex items-center gap-2 text-destructive text-sm"><AlertCircle className="h-4 w-4" />{authError}</div>
                )}
                <Button
                  type="submit"
                  className="w-full text-white border-0"
                  style={{ background: "linear-gradient(135deg, #0fd4aa 0%, #0aaa88 100%)" }}
                >
                  Login Admin
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const activeUsers = users.filter((u) => u.isActive && !u.isExpired).length;
  const expiredUsers = users.filter((u) => u.isExpired).length;
  const runningBots = strategies.filter((s) => s.isRunning).length;

  const filteredUsers = users.filter((u) => {
    const q = userSearch.toLowerCase();
    const matchSearch = !q ||
      (u.telegramName?.toLowerCase().includes(q) ?? false) ||
      (u.telegramUsername?.toLowerCase().includes(q) ?? false) ||
      u.telegramId.includes(q);
    const matchStatus =
      userStatusFilter === "all" ||
      (userStatusFilter === "aktif" && u.isActive && !u.isExpired) ||
      (userStatusFilter === "nonaktif" && (!u.isActive || u.isExpired));
    return matchSearch && matchStatus;
  });

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Shield className="h-6 w-6" /> Admin Panel</h1>
            <p className="text-sm text-muted-foreground">Kelola HokirecehPro</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { fetchUsers(); fetchStrategies(); fetchPayments(); }} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardContent className="pt-4 text-center"><p className="text-2xl sm:text-3xl font-bold">{users.length}</p><p className="text-xs sm:text-sm text-muted-foreground">Total User</p></CardContent></Card>
          <Card><CardContent className="pt-4 text-center"><p className="text-2xl sm:text-3xl font-bold text-green-600">{activeUsers}</p><p className="text-xs sm:text-sm text-muted-foreground">Aktif</p></CardContent></Card>
          <Card><CardContent className="pt-4 text-center"><p className="text-2xl sm:text-3xl font-bold text-red-500">{expiredUsers}</p><p className="text-xs sm:text-sm text-muted-foreground">Expired</p></CardContent></Card>
          <Card><CardContent className="pt-4 text-center"><p className="text-2xl sm:text-3xl font-bold text-blue-500">{runningBots}</p><p className="text-xs sm:text-sm text-muted-foreground">Bot Running</p></CardContent></Card>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 px-3 py-2 rounded">
            <AlertCircle className="h-4 w-4" />{error}
            <button onClick={() => setError("")} className="ml-auto text-xs underline">Dismiss</button>
          </div>
        )}

        <Tabs defaultValue="users">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="users" className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Users</span>
            </TabsTrigger>
            <TabsTrigger value="monitor" className="flex items-center gap-1">
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Monitor</span>
            </TabsTrigger>
            <TabsTrigger value="payments" className="flex items-center gap-1">
              <CreditCard className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Payments</span>
            </TabsTrigger>
            <TabsTrigger value="broadcast" className="flex items-center gap-1">
              <Megaphone className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Broadcast</span>
            </TabsTrigger>
          </TabsList>

          {/* ===== USERS TAB ===== */}
          <TabsContent value="users" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4" /> Tambah User Manual</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={addUser} className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-32 space-y-1">
                    <Label className="text-xs">Telegram ID</Label>
                    <Input placeholder="123456789" value={newTelegramId} onChange={(e) => setNewTelegramId(e.target.value)} required />
                  </div>
                  <div className="flex-1 min-w-32 space-y-1">
                    <Label className="text-xs">Nama (opsional)</Label>
                    <Input placeholder="Nama user" value={newTelegramName} onChange={(e) => setNewTelegramName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Paket</Label>
                    <Select value={newPlan} onValueChange={setNewPlan}>
                      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30d">30 Hari</SelectItem>
                        <SelectItem value="60d">60 Hari</SelectItem>
                        <SelectItem value="90d">90 Hari</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="submit" disabled={addLoading || !newTelegramId}>{addLoading ? "..." : "Tambah"}</Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" /> Daftar User
                  <span className="font-normal text-muted-foreground">
                    ({filteredUsers.length}{filteredUsers.length !== users.length ? ` / ${users.length}` : ""})
                  </span>
                </CardTitle>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Cari nama, @username, atau ID..."
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      className="pl-8 h-8 text-sm"
                    />
                  </div>
                  <Select value={userStatusFilter} onValueChange={(v) => setUserStatusFilter(v as "all" | "aktif" | "nonaktif")}>
                    <SelectTrigger className="w-32 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Semua</SelectItem>
                      <SelectItem value="aktif">Aktif</SelectItem>
                      <SelectItem value="nonaktif">Nonaktif</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                {users.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Belum ada user</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Tidak ada user yang cocok</p>
                ) : (
                  <div className="space-y-3">
                    {filteredUsers.map((u) => (
                      <div key={u.id} className="border rounded-lg p-3 space-y-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-sm">{u.telegramName || `User-${u.telegramId}`}
                              {u.telegramUsername && <span className="text-muted-foreground ml-1">@{u.telegramUsername}</span>}
                            </p>
                            <p className="text-xs text-muted-foreground">ID: {u.telegramId}</p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={u.isExpired ? "destructive" : "default"} className="text-xs">
                              {u.isExpired ? "Expired" : u.isActive ? "Aktif" : "Nonaktif"}
                            </Badge>
                            <Badge variant="outline" className="text-xs">{PLAN_LABELS[u.plan] || u.plan}</Badge>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono bg-muted px-2 py-0.5 rounded">{u.password}</span>
                          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> s/d {formatWIBDate(u.expiresAt)}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {extendId === u.id ? (
                            <div className="flex gap-2 items-center">
                              <Input type="number" className="w-20 h-7 text-xs" value={extendDays} onChange={(e) => setExtendDays(e.target.value)} min="1" />
                              <span className="text-xs text-muted-foreground">hari</span>
                              <Button size="sm" className="h-7 text-xs" onClick={() => extendUser(u.id)}>Konfirmasi</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setExtendId(null)}>Batal</Button>
                            </div>
                          ) : confirmDeleteId === u.id ? (
                            <div className="flex gap-2 items-center">
                              <span className="text-xs text-destructive font-medium">Hapus permanen?</span>
                              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => permanentDeleteUser(u.id)}>Ya, Hapus</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDeleteId(null)}>Batal</Button>
                            </div>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setExtendId(u.id); setExtendDays("30"); }}>
                                <Calendar className="h-3 w-3 mr-1" /> Perpanjang
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resetPassword(u.id)}>Reset Password</Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs text-orange-500 border-orange-500/30 hover:bg-orange-500/10" onClick={() => deactivateUser(u.id)}>
                                Nonaktifkan
                              </Button>
                              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => setConfirmDeleteId(u.id)}>
                                <Trash2 className="h-3 w-3 mr-1" /> Hapus Permanen
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== MONITOR BOT TAB ===== */}
          <TabsContent value="monitor" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Monitor className="h-4 w-4" /> Semua Strategi ({strategies.length})</CardTitle>
                <CardDescription>Strategi dari seluruh user</CardDescription>
              </CardHeader>
              <CardContent>
                {strategies.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Belum ada strategi</p>
                ) : (
                  <div className="space-y-2">
                    {strategies.map((s) => {
                      const busy = busyBotIds.has(s.id);
                      return (
                        <div key={s.id} className="border rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${s.isRunning ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`} />
                              <span className="font-medium text-sm truncate">{s.name}</span>
                              <span className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{s.marketSymbol}</span>
                              <span className="text-xs uppercase text-primary font-bold">{s.type}</span>
                              {(() => {
                                const ex = EXCHANGE_BADGE[s.exchange] ?? { label: s.exchange, className: "bg-muted text-muted-foreground border-muted" };
                                return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${ex.className}`}>{ex.label}</span>;
                              })()}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 ml-4">
                              {s.user ? `${s.user.telegramName || s.user.telegramId}${s.user.telegramUsername ? ` @${s.user.telegramUsername}` : ""}` : "No user"}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <span className={
                              s.livePnl == null ? "text-muted-foreground" :
                              s.livePnl > 0 ? "text-green-600" :
                              s.livePnl < 0 ? "text-red-500" : "text-muted-foreground"
                            }>
                              <span className="font-medium">Account PnL (Live)</span>
                              {" "}
                              {s.livePnl == null
                                ? "-"
                                : `${s.livePnl > 0 ? "+" : ""}${s.livePnl.toFixed(4)}`}
                              {" "}
                              <span className="text-muted-foreground font-normal">(Per Akun)</span>
                            </span>
                            <span className="text-muted-foreground">{s.successfulOrders}/{s.totalOrders} orders</span>
                            <Badge variant={s.isRunning ? "default" : "secondary"} className="text-xs">
                              {s.isRunning ? "Running" : "Stopped"}
                            </Badge>
                            {s.isRunning ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                disabled={busy}
                                onClick={() => setConfirmStop(s)}
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 mr-1" />}
                                {!busy && "Stop"}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10 hover:text-green-300"
                                disabled={busy}
                                onClick={() => handleBotAction(s, "start")}
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                                {!busy && "Start"}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== PAYMENTS TAB ===== */}
          <TabsContent value="payments" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Pending Payments ({payments.length})</CardTitle>
                <CardDescription>Transaksi Saweria yang sedang menunggu konfirmasi</CardDescription>
              </CardHeader>
              <CardContent>
                {payments.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Tidak ada pending payment</p>
                ) : (
                  <div className="space-y-2">
                    {payments.map((p) => (
                      <div key={p.id} className="border rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-medium text-sm">{p.telegramName}</span>
                            {p.telegramUsername && <span className="text-muted-foreground ml-1 text-xs">@{p.telegramUsername}</span>}
                          </div>
                          <Badge variant="outline" className="text-xs">{PLAN_LABELS[p.plan] || p.plan}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <span>ID: {p.telegramId}</span>
                          <span>Rp {p.amount.toLocaleString("id")}</span>
                          <span>Donation: {p.donationId}</span>
                          <span>Expires: {formatWIBDate(p.expiresAt)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">Created: {formatWIBDate(p.createdAt)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== BROADCAST TAB ===== */}
          <TabsContent value="broadcast" className="space-y-4 mt-4">

            {/* ── Compose ────────────────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Megaphone className="h-4 w-4" /> Broadcast Pesan
                    </CardTitle>
                    <CardDescription>Kirim pesan Telegram ke user — mendukung rich text HTML</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchBroadcastHistory(); }}>
                    <History className="h-4 w-4 mr-1" /> Riwayat
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleBroadcast} className="space-y-4">

                  {/* Options row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Format</Label>
                      <Select value={broadcastParseMode} onValueChange={(v) => setBroadcastParseMode(v as any)}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="HTML">HTML (disarankan)</SelectItem>
                          <SelectItem value="MarkdownV2">MarkdownV2</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Target</Label>
                      <Select value={broadcastTargetFilter} onValueChange={(v) => setBroadcastTargetFilter(v as any)}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Subscriber aktif saja (belum expired)</SelectItem>
                          <SelectItem value="all">Semua yang pernah /start (NeonDB)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Format toolbar (HTML mode) */}
                  {broadcastParseMode === "HTML" && (
                    <div className="space-y-1">
                      <Label className="text-xs">Format Teks</Label>
                      <div className="flex flex-wrap gap-1 p-2 border rounded-lg bg-muted/30">
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Bold" onClick={() => insertFormat("<b>", "</b>")}>
                          <Bold className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Italic" onClick={() => insertFormat("<i>", "</i>")}>
                          <Italic className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Underline" onClick={() => insertFormat("<u>", "</u>")}>
                          <Underline className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Strikethrough" onClick={() => insertFormat("<s>", "</s>")}>
                          <Strikethrough className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Code inline" onClick={() => insertFormat("<code>", "</code>")}>
                          <Code className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs font-mono" title="Pre block" onClick={() => insertFormat("<pre>", "</pre>")}>
                          {"</>"}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Spoiler" onClick={() => insertFormat("<tg-spoiler>", "</tg-spoiler>")}>
                          👁 Spoiler
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Link" aria-label="Sisipkan link" onClick={() => insertFormat('<a href="https://">', "</a>")}>
                          <Link className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Blockquote" onClick={() => insertFormat("<blockquote>", "</blockquote>")}>
                          ❝ Quote
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Expandable blockquote" onClick={() => insertFormat('<blockquote expandable>', "</blockquote>")}>
                          ❝ Expand
                        </Button>
                        <div className="ml-auto">
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowPreview(!showPreview)}>
                            {showPreview ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                            {showPreview ? "Tutup Preview" : "Preview"}
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Klik tombol lalu pilih teks untuk membungkus, atau klik lalu ketik langsung. Entity otomatis: @mention #hashtag $BTC URL email +628xx
                      </p>
                    </div>
                  )}

                  {/* Textarea */}
                  <div className="space-y-2">
                    <Label>Pesan</Label>
                    <Textarea
                      ref={broadcastTextareaRef}
                      placeholder={broadcastParseMode === "HTML"
                        ? "Tulis pesan... Contoh: <b>Halo!</b> Update terbaru sudah live 🚀"
                        : "Tulis pesan... Contoh: *Halo\\!* Update terbaru sudah live 🚀"
                      }
                      value={broadcastMsg}
                      onChange={(e) => setBroadcastMsg(e.target.value)}
                      rows={6}
                      className="font-mono text-sm"
                      required
                    />
                  </div>

                  {/* Preview (raw HTML display) */}
                  {showPreview && broadcastMsg && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Preview (approx — tanpa rendering Telegram)</Label>
                      <div
                        className="p-3 border rounded-lg text-sm bg-muted/20 whitespace-pre-wrap break-words"
                        dangerouslySetInnerHTML={{ __html: broadcastMsg.replace(/\n/g, "<br>") }}
                      />
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    <Button type="submit" disabled={broadcastLoading || !broadcastMsg.trim()} className="flex-1">
                      <Send className="h-4 w-4 mr-2" />
                      {broadcastLoading ? "Mengirim..." : `Kirim Broadcast`}
                    </Button>
                    {broadcastLoading && broadcastJobId && (
                      <Button type="button" variant="destructive" size="default" onClick={handleCancelBroadcast}>
                        <XCircle className="h-4 w-4 mr-1" /> Batalkan
                      </Button>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* ── Progress ──────────────────────────────────────────────────── */}
            {broadcastJob && broadcastJob.status !== "idle" && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    {broadcastJob.status === "running" && <Clock className="h-4 w-4 animate-spin text-blue-500" />}
                    {broadcastJob.status === "completed" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                    {broadcastJob.status === "cancelled" && <Ban className="h-4 w-4 text-yellow-500" />}
                    {broadcastJob.status === "failed" && <XCircle className="h-4 w-4 text-red-500" />}
                    {broadcastJob.status === "pending" && <Clock className="h-4 w-4 text-muted-foreground" />}
                    Status Broadcast
                    <Badge variant="outline" className="ml-auto text-xs">
                      {broadcastJob.status === "running" ? "Berjalan" :
                       broadcastJob.status === "completed" ? "Selesai" :
                       broadcastJob.status === "cancelled" ? "Dibatalkan" :
                       broadcastJob.status === "failed" ? "Gagal" : "Antrian"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Progress bar */}
                  {broadcastJob.total > 0 && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{broadcastJob.sent + broadcastJob.failed} / {broadcastJob.total} diproses</span>
                        <span>{Math.round(((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total) * 100)}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-500 rounded-full"
                          style={{ width: `${((broadcastJob.sent + broadcastJob.failed) / broadcastJob.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="p-2 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-green-500">{broadcastJob.sent}</div>
                      <div className="text-xs text-muted-foreground">Terkirim</div>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-red-500">{broadcastJob.failed}</div>
                      <div className="text-xs text-muted-foreground">Gagal</div>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold text-yellow-500">{broadcastJob.skipped ?? 0}</div>
                      <div className="text-xs text-muted-foreground">Skip</div>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/30">
                      <div className="text-lg font-bold">{broadcastJob.total}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                  </div>

                  {/* Circuit breaker status */}
                  {broadcastJob.circuitBreakerState !== "closed" && (
                    <div className={`text-xs px-3 py-2 rounded-lg border ${
                      broadcastJob.circuitBreakerState === "open"
                        ? "bg-red-500/10 border-red-500/30 text-red-600"
                        : "bg-yellow-500/10 border-yellow-500/30 text-yellow-600"
                    }`}>
                      ⚡ Circuit breaker: {broadcastJob.circuitBreakerState === "open" ? "OPEN — menunggu recovery 30s" : "Half-open — mencoba kembali"}
                    </div>
                  )}

                  {/* Last errors */}
                  {broadcastJob.lastErrors && broadcastJob.lastErrors.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        {broadcastJob.lastErrors.length} error terakhir
                      </summary>
                      <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                        {broadcastJob.lastErrors.slice(0, 10).map((e, i) => (
                          <div key={i} className="font-mono bg-muted/30 rounded px-2 py-1">
                            <span className="text-muted-foreground">{e.chatId}: </span>{e.error}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ── History ───────────────────────────────────────────────────── */}
            {showHistory && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <History className="h-4 w-4" /> Riwayat Broadcast
                    <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={fetchBroadcastHistory}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {broadcastHistory.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">Belum ada riwayat broadcast</p>
                  ) : (
                    <div className="space-y-2">
                      {broadcastHistory.map((job) => (
                        <div key={job.id} className="flex items-center gap-3 p-3 border rounded-lg text-sm">
                          <div className="flex-shrink-0">
                            {job.status === "completed" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                            {job.status === "cancelled" && <Ban className="h-4 w-4 text-yellow-500" />}
                            {job.status === "failed" && <XCircle className="h-4 w-4 text-red-500" />}
                            {job.status === "running" && <Clock className="h-4 w-4 text-blue-500 animate-spin" />}
                            {job.status === "pending" && <Clock className="h-4 w-4 text-muted-foreground" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline" className="text-xs">{job.parseMode}</Badge>
                              <Badge variant="outline" className="text-xs">{job.targetFilter}</Badge>
                              <span className="text-xs text-muted-foreground">
                                {job.createdAt ? new Date(job.createdAt).toLocaleString("id-ID") : ""}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 truncate">{job.message.slice(0, 80)}{job.message.length > 80 ? "…" : ""}</div>
                          </div>
                          <div className="text-right text-xs flex-shrink-0">
                            <span className="text-green-500 font-medium">{job.sent}</span>
                            <span className="text-muted-foreground">/{job.total}</span>
                            {job.failed > 0 && <span className="text-red-500 ml-1">({job.failed} ✕)</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ── Entity reference ─────────────────────────────────────────── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Referensi 18 Entity Type Telegram</CardTitle>
                <CardDescription className="text-xs">Semua format yang didukung untuk rich text Telegram</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {[
                    { label: "Bold", ex: "<b>teks</b>" },
                    { label: "Italic", ex: "<i>teks</i>" },
                    { label: "Underline", ex: "<u>teks</u>" },
                    { label: "Strikethrough", ex: "<s>teks</s>" },
                    { label: "Spoiler", ex: "<tg-spoiler>teks</tg-spoiler>" },
                    { label: "Code inline", ex: "<code>kode</code>" },
                    { label: "Pre block", ex: "<pre>blok</pre>" },
                    { label: "Code block", ex: '<pre language="py">...</pre>' },
                    { label: "Link", ex: '<a href="https://...">teks</a>' },
                    { label: "Mention", ex: "@username" },
                    { label: "Hashtag", ex: "#hashtag" },
                    { label: "Cashtag", ex: "$BTC" },
                    { label: "Bot command", ex: "/command" },
                    { label: "URL (auto)", ex: "https://..." },
                    { label: "Email (auto)", ex: "user@email.com" },
                    { label: "Phone (auto)", ex: "+62812..." },
                    { label: "Blockquote", ex: "<blockquote>...</blockquote>" },
                    { label: "Expandable", ex: '<blockquote expandable>...</blockquote>' },
                  ].map(({ label, ex }) => (
                    <div key={label} className="flex items-start gap-2 p-2 rounded-lg bg-muted/20 text-xs">
                      <span className="text-muted-foreground w-24 flex-shrink-0 font-medium">{label}</span>
                      <code className="font-mono text-[10px] text-primary/80 break-all">{ex}</code>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ── AlertDialog: Konfirmasi Stop Bot ─────────────────────────── */}
      <AlertDialog open={!!confirmStop} onOpenChange={(open) => { if (!open) setConfirmStop(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Bot Darurat?</AlertDialogTitle>
            <AlertDialogDescription>
              Bot <span className="font-semibold text-foreground">{confirmStop?.name}</span>{" "}
              ({confirmStop?.exchange} — {confirmStop?.marketSymbol}) akan dihentikan.
              Semua order aktif yang sedang berjalan akan dibatalkan oleh bot engine.
              Tindakan ini tidak bisa dibatalkan secara otomatis.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmStop(null)}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmStop) {
                  handleBotAction(confirmStop, "stop");
                  setConfirmStop(null);
                }
              }}
            >
              Ya, Stop Bot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
