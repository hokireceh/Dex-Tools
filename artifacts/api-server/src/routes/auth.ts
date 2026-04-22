import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { createSession, getSession, deleteSession } from "../lib/sessionStore";
import { timingSafeEqual, createHash } from "crypto";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const router = Router();

const COOKIE_NAME = "lb_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function resolveBearerPassword(req: any): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  return null;
}

router.post("/login", async (req, res) => {
  const { password } = req.body as { password?: string };
  const trimmed = password?.trim().toUpperCase() ?? "";
  if (!trimmed) return res.status(400).json({ error: "Password diperlukan" });

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword && safeCompare(trimmed, adminPassword.trim().toUpperCase())) {
    const sessionToken = createSession({ type: "admin" });
    res.cookie(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return res.json({
      id: 0,
      telegramId: "admin",
      telegramName: "Admin",
      telegramUsername: "admin",
      plan: "lifetime",
      expiresAt: null,
      isAdmin: true,
    });
  }

  try {
    const bcrypt = await import("bcryptjs");
    const matchedUser = await db.query.usersTable.findFirst({
      where: and(
        eq(usersTable.password, trimmed),
        eq(usersTable.isActive, true),
        gt(usersTable.expiresAt, new Date())
      ),
    });

    if (!matchedUser) {
      return res.status(401).json({ error: "Password salah atau langganan sudah habis" });
    }

    if (!matchedUser.passwordHash) {
      return res.status(401).json({ error: "Password salah atau langganan sudah habis" });
    }
    const valid = await bcrypt.compare(trimmed, matchedUser.passwordHash);
    if (!valid) return res.status(401).json({ error: "Password salah atau langganan sudah habis" });

    const sessionToken = createSession({ type: "user", userId: matchedUser.id, telegramId: matchedUser.telegramId });
    res.cookie(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    return res.json({
      id: matchedUser.id,
      telegramId: matchedUser.telegramId,
      telegramName: matchedUser.telegramName,
      telegramUsername: matchedUser.telegramUsername,
      plan: matchedUser.plan,
      expiresAt: matchedUser.expiresAt.toISOString(),
    });
  } catch {
    return res.status(500).json({ error: "Auth error" });
  }
});

router.post("/logout", (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) deleteSession(token as string);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  return res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  // Bearer header: backward compat untuk non-browser / API client
  const bearerRaw = resolveBearerPassword(req);
  if (bearerRaw) {
    const password = bearerRaw.trim().toUpperCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminPassword && safeCompare(password, adminPassword.trim().toUpperCase())) {
      return res.json({
        id: 0,
        telegramId: "admin",
        telegramName: "Admin",
        telegramUsername: "admin",
        plan: "lifetime",
        expiresAt: null,
        isAdmin: true,
      });
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
      if (!matchedUser.passwordHash) return res.status(401).json({ error: "Unauthorized" });
      const valid = await bcrypt.compare(password, matchedUser.passwordHash);
      if (!valid) return res.status(401).json({ error: "Unauthorized" });
      return res.json({
        id: matchedUser.id,
        telegramId: matchedUser.telegramId,
        telegramName: matchedUser.telegramName,
        telegramUsername: matchedUser.telegramUsername,
        plan: matchedUser.plan,
        expiresAt: matchedUser.expiresAt.toISOString(),
      });
    } catch {
      return res.status(500).json({ error: "Auth error" });
    }
  }

  // Cookie path: session token
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const session = getSession(token);
  if (!session) {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    return res.status(401).json({ error: "Sesi tidak valid atau sudah expired" });
  }

  if (session.type === "admin") {
    return res.json({
      id: 0,
      telegramId: "admin",
      telegramName: "Admin",
      telegramUsername: "admin",
      plan: "lifetime",
      expiresAt: null,
      isAdmin: true,
    });
  }

  try {
    const user = await db.query.usersTable.findFirst({
      where: and(
        eq(usersTable.id, session.userId),
        eq(usersTable.isActive, true),
        gt(usersTable.expiresAt, new Date())
      ),
    });
    if (!user) {
      deleteSession(token);
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(401).json({ error: "User tidak ditemukan atau langganan sudah habis" });
    }
    return res.json({
      id: user.id,
      telegramId: user.telegramId,
      telegramName: user.telegramName,
      telegramUsername: user.telegramUsername,
      plan: user.plan,
      expiresAt: user.expiresAt.toISOString(),
    });
  } catch {
    return res.status(500).json({ error: "Auth error" });
  }
});

export default router;
