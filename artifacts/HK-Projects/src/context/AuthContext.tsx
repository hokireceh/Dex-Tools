import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

export interface AuthUser {
  id: number;
  telegramId: string;
  telegramName: string | null;
  telegramUsername: string | null;
  plan: string;
  expiresAt: string | null;
  isAdmin?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  token: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const fetchMe = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      return await res.json() as AuthUser;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pk = params.get("pk");
    if (pk) {
      params.delete("pk");
      const cleanSearch = params.toString();
      const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ""}${window.location.hash}`;
      window.history.replaceState({}, document.title, cleanUrl);
    }
    const autoLogin = pk ? fetch("/api/auth/login", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pk }),
    }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);

    autoLogin.then(autoUser => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const source = autoUser ? Promise.resolve(autoUser) : Promise.race([fetchMe(), timeout]);
      return source.then((u) => { setUser(u); setIsLoading(false); }).catch(() => setIsLoading(false));
    });
  }, []);

  const login = useCallback(async (password: string) => {
    const trimmed = password.trim().toUpperCase();
    if (!trimmed) return { success: false, error: "Password tidak boleh kosong" };

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: data.error ?? "Password salah atau langganan sudah habis" };
      }
      const userData = await res.json() as AuthUser;
      setUser(userData);
      return { success: true };
    } catch {
      return { success: false, error: "Gagal menghubungi server" };
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setUser(null);
    // FE-LAYOUT-003: clear React Query cache to prevent data leak across users on shared browser
    queryClient.clear();
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout, token: null }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
