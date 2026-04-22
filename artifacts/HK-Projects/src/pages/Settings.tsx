import { useEffect, useState, useRef, forwardRef, useImperativeHandle } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useGetBotConfig, useUpdateBotConfig } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Settings as SettingsIcon, Save, KeyRound, ShieldAlert, Search, CheckCircle2, Bell, Bot, Send, Loader2, Eye, EyeOff, AlertTriangle, Zap, Code2, Trash2 } from "lucide-react";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { toast } from "sonner";

const configSchema = z.object({
  network: z.enum(["mainnet"]),
  accountIndex: z.coerce.number().nullable().optional(),
  apiKeyIndex: z.preprocess(
    (val) => (val === "" || val === null || val === undefined) ? null : Number(val),
    z.number()
      .int("Harus bilangan bulat")
      .min(3, "Index minimal 3 (indeks 0–2 dicadangkan Lighter)")
      .max(254, "Index maksimal 254")
      .nullable()
      .optional()
  ),
  privateKey: z.string().optional(),
  l1Address: z.string().optional(),
  notifyBotToken: z.string().optional(),
  notifyChatId: z.string().optional(),
  notifyOnBuy: z.boolean().optional(),
  notifyOnSell: z.boolean().optional(),
  notifyOnError: z.boolean().optional(),
  notifyOnStart: z.boolean().optional(),
  notifyOnStop: z.boolean().optional(),
  lighterReadonlyToken: z.string().optional(),
});

type FormData = z.infer<typeof configSchema>;

// FE-SETTINGS-005: shared component untuk display read-only Mainnet badge
// (sebelumnya 4× duplikasi inline di Lighter/Extended/Ethereal/Nado section).
function MainnetBadge({ label = "Mainnet", widthClass = "w-48" }: { label?: string; widthClass?: string }) {
  return (
    <div className={`flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-muted/30 text-sm ${widthClass}`}>
      <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
      {label}
    </div>
  );
}

// ── Extended DEX Credentials Section ─────────────────────────────────────────

const JSON_TEMPLATE = `{
  "EXTENDED_API_KEY": "",
  "EXTENDED_STARK_PRIVATE_KEY": "",
  "EXTENDED_COLLATERAL_POSITION": ""
}`;

// FE-SETTINGS-002: Zod schema untuk validasi shape JSON paste mode Extended.
// Sebelumnya handleJsonChange menerima nilai tipe apa pun (number/null/object) →
// state setApiKey(...) bisa diset ke non-string yang gagal saat .trim() di handleSave.
const extendedJsonSchema = z.object({
  EXTENDED_API_KEY: z.string().optional(),
  EXTENDED_STARK_PRIVATE_KEY: z.string().optional(),
  EXTENDED_COLLATERAL_POSITION: z.union([z.string(), z.number()]).optional(),
});

const ExtendedConfigSection = forwardRef<{ save: () => Promise<void> }>(function ExtendedConfigSection(_, ref) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [cfg, setCfg] = useState<{ hasApiKey: boolean; hasPrivateKey: boolean; hasAccountId: boolean; accountId: string | null; extendedNetwork: "mainnet" }>({
    hasApiKey: false, hasPrivateKey: false, hasAccountId: false, accountId: null, extendedNetwork: "mainnet",
  });
  const [apiKey, setApiKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [extendedNetwork, setExtendedNetwork] = useState<"mainnet">("mainnet");
  const [showKey, setShowKey] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState(JSON_TEMPLATE);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/extended/strategies/user-config", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setCfg(data);
          setAccountId(data.accountId ?? "");
          setExtendedNetwork(data.extendedNetwork ?? "mainnet");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    setJsonError(null);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setJsonError("Format JSON tidak valid");
      return;
    }
    // FE-SETTINGS-002: validasi shape via Zod sebelum setState — cegah type pollution
    // (mis. user paste {"EXTENDED_API_KEY": 12345} → setApiKey menerima number).
    const result = extendedJsonSchema.safeParse(raw);
    if (!result.success) {
      const detail = result.error.errors
        .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
        .join("; ");
      setJsonError(`Field tidak valid — ${detail}`);
      return;
    }
    if (result.data.EXTENDED_API_KEY !== undefined) setApiKey(result.data.EXTENDED_API_KEY);
    if (result.data.EXTENDED_STARK_PRIVATE_KEY !== undefined) setPrivateKey(result.data.EXTENDED_STARK_PRIVATE_KEY);
    if (result.data.EXTENDED_COLLATERAL_POSITION !== undefined) setAccountId(String(result.data.EXTENDED_COLLATERAL_POSITION));
  };

  const handleToggleJsonMode = () => {
    if (!jsonMode) {
      setJsonText(JSON.stringify({
        EXTENDED_API_KEY: apiKey,
        EXTENDED_STARK_PRIVATE_KEY: privateKey,
        EXTENDED_COLLATERAL_POSITION: accountId,
      }, null, 2));
      setJsonError(null);
    }
    setJsonMode(v => !v);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = { extendedNetwork };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (privateKey.trim()) body.privateKey = privateKey.trim();
      if (accountId.trim()) body.accountId = accountId.trim();

      const res = await fetch("/api/extended/strategies/user-config", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Gagal menyimpan");

      setApiKey("");
      setPrivateKey("");
      toast.success("Konfigurasi Extended Disimpan");
      // Refresh status
      fetch("/api/extended/strategies/user-config", { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            setCfg(data);
            setExtendedNetwork(data.extendedNetwork ?? "mainnet");
          }
        })
        .catch(() => {});
    } catch (err: any) {
      toast.error("Kesalahan", { description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/extended/strategies/credentials", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Gagal mereset");
      setCfg({ hasApiKey: false, hasPrivateKey: false, hasAccountId: false, accountId: null, extendedNetwork: "mainnet" });
      setApiKey("");
      setPrivateKey("");
      setAccountId("");
      setExtendedNetwork("mainnet");
      toast.success("Credentials Extended berhasil direset");
    } catch {
      toast.error("Gagal mereset credentials Extended");
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  };

  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; });
  useImperativeHandle(ref, () => ({ save: () => handleSaveRef.current() }), []);

  return (
    <Card className="glass-panel">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ExchangeLogo exchange="extended" size={20} />
              Kredensial Extended DEX
            </CardTitle>
            <CardDescription className="mt-1">
              API Key dan Stark Private Key untuk Extended DEX. Disimpan terenkripsi. l2Vault (collateral position untuk signing) diambil otomatis dari API saat bot start.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleToggleJsonMode}
            className="shrink-0 gap-1.5 text-xs font-mono"
          >
            <Code2 className="w-3.5 h-3.5" />
            {jsonMode ? "Edit Form" : "{ } Edit as JSON"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="space-y-3">
            <div className="h-10 bg-muted animate-pulse rounded" />
            <div className="h-10 bg-muted animate-pulse rounded" />
            <div className="h-10 bg-muted animate-pulse rounded" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 mb-4">
              {[
                { label: "API Key", ok: cfg.hasApiKey },
                { label: "Stark Private Key", ok: cfg.hasPrivateKey },
                { label: "Account ID", ok: cfg.hasAccountId },
              ].map(({ label, ok }) => (
                <div key={label} className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${ok ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-muted/50 border-border text-muted-foreground"}`}>
                  {ok ? <CheckCircle2 className="w-3 h-3" /> : <Zap className="w-3 h-3 opacity-50" />}
                  {label} {ok ? "✓" : "belum diset"}
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-muted-foreground" /> Jaringan Extended
              </Label>
              <MainnetBadge />
              <p className="text-xs text-muted-foreground">Jaringan Extended DEX — full mainnet.</p>
            </div>

            {jsonMode ? (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5 text-muted-foreground" /> Paste JSON Kredensial
                </Label>
                <textarea
                  value={jsonText}
                  onChange={e => handleJsonChange(e.target.value)}
                  rows={7}
                  spellCheck={false}
                  className={`w-full rounded-md border bg-background font-mono text-sm px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-ring ${jsonError ? "border-destructive focus:ring-destructive" : "border-input"}`}
                  placeholder={JSON_TEMPLATE}
                />
                {jsonError ? (
                  <p className="text-xs text-destructive flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{jsonError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Paste JSON lalu klik Simpan. Field kosong = hapus nilai tersimpan.</p>
                )}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-muted-foreground" /> API Key Extended
                  </Label>
                  <Input
                    type="text"
                    placeholder={cfg.hasApiKey ? "••• tersimpan — isi untuk mengganti •••" : "Masukkan Extended API Key"}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    className="bg-background font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" /> Stark Private Key
                  </Label>
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      placeholder={cfg.hasPrivateKey ? "••• tersimpan — isi untuk mengganti •••" : "Masukkan Stark Private Key"}
                      value={privateKey}
                      onChange={e => setPrivateKey(e.target.value)}
                      className="bg-background font-mono text-sm pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5 text-muted-foreground" /> Account ID
                  </Label>
                  <Input
                    type="text"
                    placeholder={cfg.hasAccountId ? "••• tersimpan — isi untuk mengganti •••" : "mis. 264658"}
                    value={accountId}
                    onChange={e => setAccountId(e.target.value)}
                    className="bg-background font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Account ID dari Extended Exchange. l2Vault yang digunakan untuk signing diambil otomatis dari API — tidak perlu diisi manual.
                  </p>
                </div>
              </>
            )}

          </>
        )}
        {!loading && (
          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowResetConfirm(true)}
              disabled={resetting || (!cfg.hasApiKey && !cfg.hasPrivateKey && !cfg.hasAccountId)}
              className="text-destructive hover:text-destructive gap-2 text-sm"
            >
              {resetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Reset Extended
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Simpan Extended
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              Reset Credentials Extended?
            </AlertDialogTitle>
            <AlertDialogDescription>
              API Key, Stark Private Key, dan Account ID Extended akan dihapus permanen dari server. Semua bot Extended yang berjalan akan berhenti.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ya, Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
});


export default function Settings() {
  const { data: config, isLoading } = useGetBotConfig();
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [detectedBalance, setDetectedBalance] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showReadonlyToken, setShowReadonlyToken] = useState(false);
  // FE-SETTINGS-001: refs `extendedRef`/`etherealRef`/`nadoRef` di-hapus karena dead code —
  // tidak ada "Save All" button yang invoke `.current.save()`. Setiap section punya tombol Save
  // sendiri dengan `setSaving` lokal yang sudah cegah race per-section.
  const [showLighterResetConfirm, setShowLighterResetConfirm] = useState(false);
  const [resettingLighter, setResettingLighter] = useState(false);

  // Cluster network-warning dihapus: aplikasi full mainnet, tidak ada network toggle.

  const updateMutation = useUpdateBotConfig({
    mutation: {
      onSuccess: () => {
        toast.success("Pengaturan Disimpan", { description: "Konfigurasi kamu telah diperbarui." });
      },
      onError: (err: any) => {
        toast.error("Error", { description: err.message || "Gagal menyimpan pengaturan" });
      }
    }
  });

  const form = useForm<FormData>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      network: "mainnet",
      accountIndex: null,
      apiKeyIndex: null,
      privateKey: "",
      l1Address: "",
      notifyBotToken: "",
      notifyChatId: "",
      notifyOnBuy: true,
      notifyOnSell: true,
      notifyOnError: true,
      notifyOnStart: true,
      notifyOnStop: false,
      lighterReadonlyToken: "",
    }
  });

  useEffect(() => {
    if (config) {
      form.reset({
        network: config.network,
        accountIndex: config.accountIndex,
        apiKeyIndex: config.apiKeyIndex,
        l1Address: config.l1Address || "",
        privateKey: "",
        notifyBotToken: "",
        notifyChatId: (config as any).notifyChatId || "",
        notifyOnBuy: config.notifyOnBuy ?? true,
        notifyOnSell: config.notifyOnSell ?? true,
        notifyOnError: config.notifyOnError ?? true,
        notifyOnStart: config.notifyOnStart ?? true,
        notifyOnStop: config.notifyOnStop ?? false,
        lighterReadonlyToken: "",
      });
    }
  }, [config, form]);

  const handleSaveLighter = form.handleSubmit((data) => {
    const payload = { ...data };
    if (!payload.privateKey) delete payload.privateKey;
    if (!payload.notifyBotToken) delete payload.notifyBotToken;
    if (!payload.lighterReadonlyToken) delete payload.lighterReadonlyToken;
    updateMutation.mutate({ data: payload });
  });

  const handleLookupAccount = async () => {
    const l1Address = form.getValues("l1Address");
    if (!l1Address || !l1Address.startsWith("0x")) {
      toast.error("Alamat Tidak Valid", { description: "Masukkan L1 address yang valid, diawali 0x" });
      return;
    }
    setIsLookingUp(true);
    setDetectedBalance(null);
    try {
      const res = await fetch(`/api/config/lookup-account?l1Address=${encodeURIComponent(l1Address)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Akun tidak ditemukan");
      }
      const data = await res.json();
      form.setValue("accountIndex", data.accountIndex);
      setDetectedBalance(data.availableBalance);
      toast.success("Akun Ditemukan", { description: `Account Index: ${data.accountIndex} | Saldo: ${parseFloat(data.availableBalance).toFixed(2)} USDC` });
    } catch (err: any) {
      toast.error("Pencarian Gagal", { description: err.message });
    } finally {
      setIsLookingUp(false);
    }
  };

  const handleTestNotification = async () => {
    setIsTesting(true);
    try {
      const res = await fetch("/api/config/test-notification", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("✅ Notifikasi Terkirim!", { description: data.message });
      } else {
        toast.error("❌ Gagal Kirim Notifikasi", { description: data.error });
      }
    } catch (err: any) {
      toast.error("Error", { description: err.message });
    } finally {
      setIsTesting(false);
    }
  };

  const handleLighterReset = async () => {
    setResettingLighter(true);
    try {
      const res = await fetch("/api/bot/credentials", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Gagal mereset");
      form.setValue("privateKey", "");
      form.setValue("accountIndex", null);
      form.setValue("apiKeyIndex", null);
      form.setValue("l1Address", "");
      setDetectedBalance(null);
      toast.success("Credentials Lighter berhasil direset");
    } catch {
      toast.error("Gagal mereset credentials Lighter");
    } finally {
      setResettingLighter(false);
      setShowLighterResetConfirm(false);
    }
  };

  return (
    <div className="space-y-8 max-w-3xl animate-in fade-in duration-500">
      <header>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
          <SettingsIcon className="w-8 h-8 text-primary" />
          Pengaturan
        </h1>
        <p className="text-muted-foreground mt-1">Konfigurasi API key Lighter.xyz dan preferensi jaringan</p>
      </header>

      {isLoading ? (
        <div className="space-y-6">
          {[1, 2].map(i => (
            <Card key={i} className="glass-panel border-border/50">
              <CardHeader>
                <div className="h-5 w-40 bg-primary/10 animate-pulse rounded" />
                <div className="h-4 w-64 bg-muted animate-pulse rounded mt-1" />
              </CardHeader>
              <CardContent className="space-y-5">
                {[1, 2, 3].map(j => (
                  <div key={j} className="space-y-2">
                    <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                    <div className="h-10 w-full bg-muted/50 animate-pulse rounded-lg" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
        <form className="space-y-6">
          <Card className="glass-panel border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ExchangeLogo exchange="lighter" size={20} />
                Kredensial Lighter DEX
              </CardTitle>
              <CardDescription>
                Dapatkan dari antarmuka Lighter.xyz. Diperlukan untuk menandatangani transaksi.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">

              <div className="flex flex-wrap gap-3 mb-2">
                {[
                  { label: "Private Key", ok: !!config?.hasPrivateKey },
                  { label: "Account Index", ok: config?.accountIndex != null },
                  { label: "Read-Only Token", ok: !!(config as any)?.hasLighterReadonlyToken },
                ].map(({ label, ok }) => (
                  <div key={label} className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${ok ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-muted/50 border-border text-muted-foreground"}`}>
                    {ok ? <CheckCircle2 className="w-3 h-3" /> : <Zap className="w-3 h-3 opacity-50" />}
                    {label} {ok ? "✓" : "belum diset"}
                  </div>
                ))}
              </div>

              {config?.hasPrivateKey && (
                <div className="bg-success/10 border border-success/30 text-success px-4 py-3 rounded-lg flex items-center gap-3 text-sm">
                  <ShieldAlert className="w-5 h-5" />
                  <div>
                    <strong>Brankas Aman:</strong> Private key sudah dikonfigurasi dan tersimpan dengan aman. Isi ulang hanya jika ingin menggantinya.
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>Jaringan</Label>
                  <MainnetBadge widthClass="w-full" />
                </div>

                <div className="space-y-2">
                  <Label>L1 Address</Label>
                  <div className="flex gap-2">
                    <Input {...form.register("l1Address")} placeholder="0x..." className="bg-background font-mono flex-1" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleLookupAccount}
                      disabled={isLookingUp}
                      className="shrink-0 px-3"
                      title="Deteksi otomatis Account Index dari L1 Address"
                      aria-label="Deteksi otomatis Account Index dari L1 Address"
                    >
                      <Search className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Isi L1 Address, lalu klik "Deteksi Otomatis" di field Account Index.</p>
                </div>

                <div className="space-y-2">
                  <Label>Account Index</Label>
                  <div className="flex gap-2">
                    <Input type="number" {...form.register("accountIndex")} placeholder="mis. 720746" className="bg-background font-mono flex-1" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleLookupAccount}
                      disabled={isLookingUp}
                      className="shrink-0 gap-1.5"
                    >
                      {isLookingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      Deteksi Otomatis
                    </Button>
                  </div>
                  {detectedBalance !== null && (
                    <div className="flex items-center gap-1 text-xs text-success">
                      <CheckCircle2 className="w-3 h-3" />
                      Terdeteksi — Saldo: {parseFloat(detectedBalance).toFixed(4)} USDC
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>API Key Index</Label>
                  <Input type="number" {...form.register("apiKeyIndex")} placeholder="mis. 7" className="bg-background font-mono" min={3} max={254} />
                  <p className="text-xs text-muted-foreground">Rentang valid: 3–254 (indeks 0–2 dicadangkan Lighter)</p>
                  {form.formState.errors.apiKeyIndex && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiKeyIndex.message as string}</p>
                  )}
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Private Key</Label>
                  <div className="relative">
                    <Input 
                      type={showPrivateKey ? "text" : "password"}
                      {...form.register("privateKey")} 
                      placeholder={config?.hasPrivateKey ? "••••••••••••••••••••••••••••••••" : "Masukkan private key..."} 
                      className="bg-background font-mono pr-10" 
                    />
                    <button
                      type="button"
                      onClick={() => setShowPrivateKey(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showPrivateKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">Jaga kerahasiaannya. Diperlukan untuk menandatangani order di Lighter.</p>
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label className="flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-muted-foreground" /> Lighter Read-Only Token
                  </Label>
                  <div className="relative">
                    <Input
                      type={showReadonlyToken ? "text" : "password"}
                      {...form.register("lighterReadonlyToken")}
                      placeholder={
                        (config as any)?.hasLighterReadonlyToken
                          ? "••• tersimpan — isi untuk mengganti •••"
                          : "ro:{account_index}:all:{expiry}:{random_hex}"
                      }
                      className="bg-background font-mono pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowReadonlyToken(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showReadonlyToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Generate di <span className="text-primary">app.lighter.xyz/read-only-tokens/</span> — Pilih expiry 10 tahun. Diperlukan untuk order sync.
                  </p>
                  <div className={`flex items-center gap-1.5 text-xs font-medium ${(config as any)?.hasLighterReadonlyToken ? "text-green-400" : "text-muted-foreground"}`}>
                    {(config as any)?.hasLighterReadonlyToken
                      ? <><CheckCircle2 className="w-3.5 h-3.5" /> Token tersimpan</>
                      : <><Zap className="w-3.5 h-3.5 opacity-50" /> Belum diisi — order sync dinonaktifkan</>
                    }
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowLighterResetConfirm(true)}
                  disabled={resettingLighter || !config?.hasPrivateKey}
                  className="text-destructive hover:text-destructive gap-2 text-sm"
                >
                  {resettingLighter ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Reset Lighter
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveLighter}
                  disabled={updateMutation.isPending}
                  className="gap-2"
                >
                  {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Simpan Lighter
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* FE-SETTINGS-001: ref prop di-hapus — Section components masih forwardRef
              (untuk capability "Save All" di masa depan) tapi parent tidak invoke. */}
          <ExtendedConfigSection />

          <Card className="glass-panel border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-primary" />
                Notifikasi Telegram
              </CardTitle>
              <CardDescription>
                Konfigurasi bot Telegram untuk menerima notifikasi trade langsung di Telegram.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5" /> Bot Token
                  </Label>
                  <Input
                    type="password"
                    {...form.register("notifyBotToken")}
                    placeholder={config?.hasNotifyBotToken ? "••••••••••••••••••••" : "123456:ABC-DEF..."}
                    className="bg-background font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Dapatkan dari <span className="text-primary">@BotFather</span> → /newbot
                    {config?.hasNotifyBotToken && <span className="text-success ml-2">✓ Terkonfigurasi</span>}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Bell className="w-3.5 h-3.5" /> Chat ID
                  </Label>
                  <Input
                    {...form.register("notifyChatId")}
                    placeholder="mis. 123456789"
                    className="bg-background font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Dapatkan dari <span className="text-primary">@userinfobot</span> → ID numerik kamu
                  </p>
                </div>
              </div>
              <div className="border-t border-border/30 pt-4 space-y-1">
                <p className="text-xs font-medium text-muted-foreground mb-3">Pemicu notifikasi</p>
              {[
                { key: "notifyOnBuy" as const, label: "Order Beli", desc: "Notifikasi saat order BUY ditempatkan" },
                { key: "notifyOnSell" as const, label: "Order Jual", desc: "Notifikasi saat order SELL ditempatkan" },
                { key: "notifyOnError" as const, label: "Error", desc: "Notifikasi saat order error atau gagal" },
                { key: "notifyOnStart" as const, label: "Bot Dimulai", desc: "Notifikasi saat bot dijalankan" },
                { key: "notifyOnStop" as const, label: "Bot Berhenti / SL/TP", desc: "Notifikasi saat bot berhenti atau SL/TP terpicu" },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                  <Switch
                    checked={form.watch(key) ?? true}
                    onCheckedChange={(v) => form.setValue(key, v)}
                  />
                </div>
              ))}
              </div>
              <div className="pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTestNotification}
                  disabled={isTesting || !config?.hasNotifyBotToken}
                  className="gap-2"
                >
                  {isTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {isTesting ? "Mengirim..." : "Test Notifikasi"}
                </Button>
                {!config?.hasNotifyBotToken && (
                  <p className="text-xs text-muted-foreground mt-1">Simpan Bot Token dulu untuk mengaktifkan test.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button 
              type="button" 
              size="lg" 
              className="text-white shadow-lg gap-2"
              style={{ background: "linear-gradient(135deg, #0fd4aa 0%, #0aaa88 100%)" }}
              disabled={updateMutation.isPending}
              onClick={handleSaveLighter}
            >
              {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {updateMutation.isPending ? "Menyimpan..." : "Simpan Notifikasi"}
            </Button>
          </div>
        </form>
        </>
      )}

      <AlertDialog open={showLighterResetConfirm} onOpenChange={setShowLighterResetConfirm}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              Reset Credentials Lighter?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Private Key, Account Index, API Key Index, dan L1 Address Lighter akan dihapus permanen dari server. Semua bot Lighter yang berjalan akan berhenti.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLighterReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ya, Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
