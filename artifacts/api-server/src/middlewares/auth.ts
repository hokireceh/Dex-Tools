import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { getSession } from "../lib/sessionStore";
import { timingSafeEqual, createHash } from "crypto";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const COOKIE_NAME = "lb_session";

export interface AuthRequest extends Request {
  userId?: number;
  userTelegramId?: string;
}

function resolveBearerPassword(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  return null;
}

export const authMiddleware: RequestHandler = async (req, res, next) => {
  const authReq = req as AuthRequest;

  // Bearer header: backward compat untuk API client (password-based)
  const bearerRaw = resolveBearerPassword(req);
  if (bearerRaw) {
    const password = bearerRaw.trim().toUpperCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminPassword && safeCompare(password, adminPassword.trim().toUpperCase())) {
      authReq.userId = 0;
      authReq.userTelegramId = "admin";
      return next();
    }
    try {
      const bcrypt = await import("bcryptjs");
      const matchedUser = await db.query.usersTable.findFirst({
        where: and(
          eq(usersTable.password, password),
          eq(usersTable.isActive, true),
          gt(usersTable.expiresAt, new Date())
        ),
      });
      if (!matchedUser) return res.status(401).json({ error: "Unauthorized" });
      // AUTH-MIDDLEWARE-COND-BCRYPT-001 FIX: passwordHash wajib ada — jika NULL,
      // tolak akses agar user tanpa hash tidak bisa bypass semua API endpoint.
      // Identik dengan fix AUTH-COND-BCRYPT-001 di routes/auth.ts.
      if (!matchedUser.passwordHash) return res.status(401).json({ error: "Unauthorized" });
      const valid = await bcrypt.compare(password, matchedUser.passwordHash);
      if (!valid) return res.status(401).json({ error: "Unauthorized" });
      authReq.userId = matchedUser.id;
      authReq.userTelegramId = matchedUser.telegramId;
      return next();
    } catch {
      return res.status(500).json({ error: "Auth error" });
    }
  }

  // Cookie path: session token
  const token = (req as any).cookies?.[COOKIE_NAME] as string | undefined;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const session = getSession(token);
  if (!session) return res.status(401).json({ error: "Sesi tidak valid atau sudah expired" });

  if (session.type === "admin") {
    authReq.userId = 0;
    authReq.userTelegramId = "admin";
    return next();
  }

  authReq.userId = session.userId;
  authReq.userTelegramId = session.telegramId;
  return next();
};

export const adminMiddleware: RequestHandler = (req, res, next) => {
  // 1. Cookie path: session token (jalur utama — browser/dashboard)
  const token = (req as any).cookies?.[COOKIE_NAME] as string | undefined;
  if (token) {
    const session = getSession(token);
    if (session?.type === "admin") return next();
  }

  // 2. Bearer path: backward compat untuk API client eksternal
  //    ADMIN_PASSWORD hanya dipakai untuk perbandingan, tidak pernah keluar dari server
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const bearer = authHeader.slice(7).trim().toUpperCase();
      if (safeCompare(bearer, adminPassword.trim().toUpperCase())) return next();
    }
  }

  return res.status(401).json({ error: "Admin access required" });
};
