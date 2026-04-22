import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { 
  LayoutDashboard, 
  Bot, 
  History, 
  Settings, 
  Terminal,
  LogOut,
  User,
  Zap,
  MoreHorizontal,
  X
} from "lucide-react";
import { useGetBotConfig } from "@workspace/api-client-react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { ExchangeLogo } from "@/components/ui/ExchangeLogo";
import { HokirecehIcon } from "@/components/ui/HokirecehIcon";

// ── Definisi navigasi dengan grouping ─────────────────────────────────────────

const generalItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/trades", label: "Trade", icon: History },
  { href: "/logs", label: "Log", icon: Terminal },
  { href: "/settings", label: "Pengaturan", icon: Settings },
];

const lighterItems = [
  { href: "/lighter", label: "Strategi Lighter", icon: Bot },
];

const extendedItems = [
  { href: "/extended", label: "Strategi Extended", icon: Zap },
];

// ── NavLink Desktop ─────────────────────────────────────────────────────────────

function NavLink({
  href,
  label,
  icon: Icon,
  location,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  location: string;
}) {
  const isActive = location === href;
  return (
    <Link
      href={href}
      className={`
        flex items-center gap-2.5
        px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150
        ${isActive
          ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 border-l-2 border-l-amber-400 rounded-l-none"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent"}
      `}
    >
      <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-amber-400" : ""}`} />
      <span className="leading-tight">{label}</span>
    </Link>
  );
}

// ── NavLink Mobile (compact, kolom vertikal) ──────────────────────────────────

function MobileNavLink({
  href,
  label,
  icon: Icon,
  location,
  accent,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  location: string;
  accent?: "amber" | "emerald";
  onClick?: () => void;
}) {
  const isActive = location === href;
  const activeColor = accent === "emerald"
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
    : "text-amber-400 bg-amber-500/10 border-amber-500/20";
  const activeIcon = accent === "emerald" ? "text-emerald-400" : "text-amber-400";

  return (
    <Link
      href={href}
      onClick={onClick}
      className={`
        flex flex-col items-center justify-center gap-0.5
        flex-1 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-150 border
        ${isActive
          ? `${activeColor}`
          : "text-muted-foreground hover:text-foreground border-transparent"}
      `}
    >
      <Icon className={`w-4 h-4 shrink-0 ${isActive ? activeIcon : ""}`} />
      <span className="leading-tight text-center">{label}</span>
    </Link>
  );
}

// ── Mobile "Lainnya" menu ─────────────────────────────────────────────────────

const moreItems = [
  { href: "/trades", label: "Trade", icon: History },
  { href: "/logs", label: "Log", icon: Terminal },
];

function MobileMoreMenu({ location }: { location: string }) {
  // FE-LAYOUT-005: replace manual click-outside listener with Radix DropdownMenu
  // (handles escape key, focus management, iOS touch reliably).
  const [open, setOpen] = useState(false);
  const hasActiveMore = moreItems.some((item) => item.href === location);

  return (
    <div className="flex-1 flex flex-col items-center relative">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={open ? "Tutup menu lainnya" : "Buka menu lainnya"}
            className={`
              flex flex-col items-center justify-center gap-0.5 w-full
              py-1.5 rounded-lg text-[10px] font-medium transition-all duration-150 border
              ${open || hasActiveMore
                ? "text-orange-400 bg-orange-500/10 border-orange-500/20"
                : "text-muted-foreground hover:text-foreground border-transparent"}
            `}
          >
            {open
              ? <X className="w-4 h-4 shrink-0 text-orange-400" />
              : <MoreHorizontal className={`w-4 h-4 shrink-0 ${hasActiveMore ? "text-orange-400" : ""}`} />
            }
            <span className="leading-tight">Lainnya</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          sideOffset={6}
          className="w-44 bg-card border border-border rounded-xl shadow-xl overflow-hidden p-0"
        >
          {moreItems.map((item) => {
            const isActive = location === item.href;
            return (
              <DropdownMenuItem
                key={item.href}
                asChild
                className="p-0 focus:bg-transparent"
              >
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`
                    flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors w-full cursor-pointer
                    ${isActive
                      ? "text-orange-400 bg-orange-500/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}
                  `}
                >
                  <item.icon className={`w-4 h-4 shrink-0 ${isActive ? "text-orange-400" : ""}`} />
                  {item.label}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── NavGroup Desktop ──────────────────────────────────────────────────────────

function NavGroup({
  label,
  accentClass,
  children,
}: {
  label: string;
  accentClass: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 px-3 mb-1">
        <span className={`text-[10px] font-bold uppercase tracking-[0.15em] ${accentClass}`}>{label}</span>
        <div className="flex-1 h-px bg-border/40" />
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// ── AppLayout ──────────────────────────────────────────────────────────────────

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: config } = useGetBotConfig();
  const { user, logout } = useAuth();

  const isConfigured = config?.hasPrivateKey && config?.accountIndex !== null;
  const isExtConfigured = !!(config as any)?.hasExtCredentials;
  const extNetwork: string = (config as any)?.extendedNetwork ?? "mainnet";
  const isExtActive = isExtConfigured;

  return (
    <div className="h-[100dvh] bg-background flex flex-col md:flex-row font-sans overflow-x-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 z-50 bg-background border border-border px-4 py-2 rounded-lg text-sm font-medium text-foreground"
      >
        Lewati navigasi
      </a>

      {/* ── Sidebar Desktop ──────────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-60 border-r border-white/[0.05] bg-white/[0.02] backdrop-blur-xl flex-col z-10 shrink-0 h-screen sticky top-0">

        {/* Brand */}
        <div className="px-5 pt-5 pb-4 border-b border-border/40">
          <div className="flex items-center gap-2.5">
            <HokirecehIcon size={34} />
            <div className="leading-none min-w-0">
              <div className="font-black text-[14px] tracking-tight uppercase leading-none">
                <span className="text-white">HOKI</span>
                <span style={{ color: '#0fd4aa' }}>RECEH</span>
              </div>
              <div className="text-[8.5px] font-bold tracking-[0.28em] uppercase text-muted-foreground mt-[5px]">PROJECTS</div>
            </div>
          </div>
          <div className="inline-flex items-center gap-1.5 mt-3 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/25">
            <HokirecehIcon size={14} />
            <span className="text-[11px] font-semibold text-amber-400 leading-none">Hokireceh Projects</span>
          </div>
        </div>

        {/* Nav desktop */}
        <nav className="flex-1 min-h-0 px-3 py-3 space-y-0.5 overflow-y-auto">
          {generalItems.map((item) => (
            <NavLink key={item.href} {...item} location={location} />
          ))}

          <NavGroup label="Lighter DEX" accentClass="text-amber-400/70">
            {lighterItems.map((item) => (
              <NavLink key={item.href} {...item} location={location} />
            ))}
          </NavGroup>

          <NavGroup label="Extended" accentClass="text-emerald-400/70">
            {extendedItems.map((item) => (
              <NavLink key={item.href} {...item} location={location} />
            ))}
          </NavGroup>
        </nav>

        {/* Status / User — satu card gabungan */}
        <div className="p-4 mt-auto">
          <div className="bg-background rounded-xl border border-border overflow-hidden">
            {/* User info */}
            {user && (
              <div className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">
                    {user.telegramName || user.telegramUsername || "User"}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">Paket</span>
                  <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                    {user.isAdmin ? "Admin" : user.plan}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-xs text-muted-foreground">Kadaluarsa</span>
                  <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                    {user.isAdmin || !user.expiresAt
                      ? "Lifetime"
                      : new Date(user.expiresAt).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}
                  </span>
                </div>
                <Button variant="ghost" size="sm" aria-label="Keluar dari aplikasi" className="w-full h-7 text-xs text-muted-foreground hover:text-destructive" onClick={logout}>
                  <LogOut className="w-3 h-3 mr-1" /> Keluar
                </Button>
              </div>
            )}

            {/* Divider full-width */}
            <div className="h-px bg-border/60" />

            {/* DEX status — Lighter, Extended */}
            <div className="divide-y divide-border/60">
              {/* Lighter */}
              <div className="px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ExchangeLogo exchange="lighter" size={10} />
                  <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-amber-400/80">Lighter</span>
                  <span className="text-[10px] text-muted-foreground">{config?.network || '—'}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isConfigured ? 'bg-amber-400 animate-pulse' : 'bg-yellow-400'}`} />
                  <span className={`text-[10px] font-medium ${isConfigured ? 'text-amber-400' : 'text-yellow-400'}`}>
                    {isConfigured ? "Ready" : "Setup"}
                  </span>
                </div>
              </div>

              {/* Extended */}
              <div className="px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ExchangeLogo exchange="extended" size={10} />
                  <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-emerald-400/80">Extended</span>
                  <span className="text-[10px] text-muted-foreground">{extNetwork}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExtActive ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
                  <span className={`text-[10px] font-medium ${isExtActive ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {isExtActive ? "Aktif" : "Setup"}
                  </span>
                </div>
              </div>

            </div>
          </div>
        </div>
      </aside>

      {/* ── Mobile Top Brand Bar ─────────────────────────────────────────────── */}
      <div className="md:hidden flex items-center justify-between px-4 pb-2.5 pt-[calc(0.625rem+var(--safe-top))] border-b border-border bg-card/80 backdrop-blur-sm shrink-0 z-20">
        <div className="flex items-center gap-2">
          <HokirecehIcon size={28} />
          <div className="leading-none">
            <div className="font-black text-[13px] tracking-tight uppercase leading-none">
              <span className="text-white">HOKI</span>
              <span style={{ color: '#0fd4aa' }}>RECEH</span>
            </div>
            <div className="text-[7.5px] font-bold tracking-[0.28em] uppercase text-muted-foreground mt-[4px]">PROJECTS</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isConfigured ? 'bg-amber-400' : 'bg-yellow-400'}`} />
          <span className={`text-[10px] font-medium ${isConfigured ? 'text-amber-400' : 'text-yellow-400'}`}>
            {isConfigured ? "Ready" : "Setup"}
          </span>
        </div>
      </div>

      {/* ── Mobile Bottom Navigation (1 baris) ──────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-card/95 backdrop-blur-md border-t border-border pb-[var(--safe-bottom)]">
        <div className="flex items-stretch px-[max(0.375rem,var(--safe-left))] pr-[max(0.375rem,var(--safe-right))] py-1.5 gap-0.5">
          {/* Dashboard */}
          <MobileNavLink href="/" label="Dashboard" icon={LayoutDashboard} location={location} />
          {/* Strategi */}
          {lighterItems.map((item) => (
            <MobileNavLink key={item.href} {...item} location={location} accent="amber" />
          ))}
          {/* Strategi Extended */}
          {extendedItems.map((item) => (
            <MobileNavLink key={item.href} {...item} location={location} accent="emerald" />
          ))}
          {/* Pengaturan */}
          <MobileNavLink href="/settings" label="Pengaturan" icon={Settings} location={location} />
          {/* Lainnya: Trade, Log, AI Advisor */}
          <MobileMoreMenu location={location} />
        </div>
      </nav>

      {/* Main Content */}
      <main id="main-content" className="flex-1 relative overflow-hidden flex flex-col min-w-0">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-success/5 rounded-full blur-[100px] pointer-events-none" />

        {!isConfigured && !isExtConfigured && location !== "/settings" && (
          <div className="border-b border-border/50 px-4 py-1.5 flex items-center justify-center gap-2 z-20">
            <span className="text-muted-foreground text-xs">API Key belum dikonfigurasi.</span>
            <Link href="/settings" className="text-xs text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors">
              Buka Pengaturan →
            </Link>
          </div>
        )}

        {/* FE-LAYOUT-004: padding bawah pakai CSS var --bottom-nav-height (lihat index.css)
            agar tinggi bottom nav single source of truth. */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-[max(1rem,var(--safe-left))] pr-[max(1rem,var(--safe-right))] py-4 md:p-8 z-10 pb-[calc(var(--bottom-nav-height)+var(--safe-bottom))] md:pb-8">
          <div className="max-w-7xl mx-auto min-h-full min-w-0">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
