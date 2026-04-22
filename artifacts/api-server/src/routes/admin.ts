import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, strategiesTable, pendingPaymentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { broadcaster, ENTITY_EXAMPLES } from "../lib/smartBroadcaster";
import {
  getActiveBroadcastContacts,
  upsertBroadcastContact,
  removeBroadcastContact,
  getBroadcastContactCount,
} from "../lib/neonBroadcastDb";
import { generatePassword, addDays } from "../lib/utils";
import { getAllRunningBots, startBot, stopBot } from "../lib/lighter/lighterBotEngine";
import { getAllRunningExtendedBots, startExtendedBot, stopExtendedBot } from "../lib/extended/extendedBotEngine";
import { getAccountByIndex } from "../lib/lighter/lighterApi";
import { getBotConfig, getExtendedCredentials } from "./configService";
import { getBalance } from "../lib/extended/extendedApi";
import type { ExtendedNetwork } from "../lib/extended/extendedApi";

const router = Router();

const PLAN_DAYS: Record<string, number> = { "30d": 30, "60d": 60, "90d": 90 };

router.get("/users", async (_req, res) => {
  try {
    const users = await db.query.usersTable.findMany({
      orderBy: (u, { desc }) => [desc(u.createdAt)],
    });
    res.json({
      users: users.map((u) => ({
        id: u.id,
        telegramId: u.telegramId,
        telegramUsername: u.telegramUsername,
        telegramName: u.telegramName,
        password: u.password,
        plan: u.plan,
        expiresAt: u.expiresAt.toISOString(),
        isActive: u.isActive,
        isExpired: u.expiresAt < new Date(),
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get users" });
  }
});

router.post("/users", async (req, res) => {
  const { telegramId, telegramUsername, telegramName, plan } = req.body as {
    telegramId: string;
    telegramUsername?: string;
    telegramName?: string;
    plan: string;
  };

  if (!telegramId || !plan || !PLAN_DAYS[plan]) {
    return res.status(400).json({ error: "telegramId dan plan wajib diisi (30d/60d/90d)" });
  }

  try {
    const bcrypt = await import("bcryptjs");
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const expiresAt = addDays(new Date(), PLAN_DAYS[plan]);

    const existing = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });

    if (existing) {
      const base = existing.expiresAt > new Date() ? existing.expiresAt : new Date();
      const newExpiry = addDays(base, PLAN_DAYS[plan]);
      await db.update(usersTable)
        .set({ password, passwordHash, plan, expiresAt: newExpiry, isActive: true, updatedAt: new Date() })
        .where(eq(usersTable.telegramId, telegramId));
      const updated = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
      return res.json({ user: updated, message: "User diupdate" });
    }

    await db.insert(usersTable).values({
      telegramId, telegramUsername: telegramUsername ?? null,
      telegramName: telegramName || `User-${telegramId}`, password, passwordHash, plan, expiresAt, isActive: true,
    });

    const created = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    res.status(201).json({ user: created, message: "User ditambahkan" });
  } catch (err) {
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.put("/users/:id", async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) return res.status(400).json({ error: "id tidak valid" });
  const { isActive, extendDays, plan, resetPassword } = req.body as {
    isActive?: boolean;
    extendDays?: number;
    plan?: string;
    resetPassword?: boolean;
  };

  try {
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, id) });
    if (!user) return res.status(404).json({ error: "User not found" });

    const bcrypt = await import("bcryptjs");
    const updates: Partial<typeof usersTable.$inferInsert> = { updatedAt: new Date() };

    if (isActive !== undefined) updates.isActive = isActive;
    if (plan && PLAN_DAYS[plan]) updates.plan = plan;
    if (resetPassword) {
      const newPassword = generatePassword();
      updates.password = newPassword;
      updates.passwordHash = await bcrypt.hash(newPassword, 12);
    }
    if (extendDays && extendDays > 0) {
      const base = user.expiresAt > new Date() ? user.expiresAt : new Date();
      updates.expiresAt = addDays(base, extendDays);
    }

    await db.update(usersTable).set(updates).where(eq(usersTable.id, id));
    const updated = await db.query.usersTable.findFirst({ where: eq(usersTable.id, id) });
    res.json({ user: updated });
  } catch (err) {
    res.status(500).json({ error: "Failed to update user" });
  }
});

router.delete("/users/:id", async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) return res.status(400).json({ error: "id tidak valid" });
  const permanent = req.query.permanent === "true";
  try {
    if (permanent) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
      res.json({ message: "User dihapus permanen" });
    } else {
      await db.update(usersTable).set({ isActive: false, updatedAt: new Date() }).where(eq(usersTable.id, id));
      res.json({ message: "User dinonaktifkan" });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

router.get("/all-strategies", async (_req, res) => {
  try {
    const strategies = await db.query.strategiesTable.findMany({
      orderBy: [desc(strategiesTable.updatedAt)],
    });
    const users = await db.query.usersTable.findMany();
    const userMap = new Map(users.map((u) => [u.id, u]));

    const lighterRunning = new Set(getAllRunningBots().map((b) => b.strategyId));
    const extendedRunning = new Set(getAllRunningExtendedBots().map((b) => b.strategyId));

    const lighterUserIds = new Set(
      strategies.filter((s) => lighterRunning.has(s.id) && s.userId != null).map((s) => s.userId!)
    );
    const extendedUserIds = new Set(
      strategies.filter((s) => extendedRunning.has(s.id) && s.userId != null).map((s) => s.userId!)
    );

    const lighterPnlMap = new Map<number, number | null>();
    const extendedPnlMap = new Map<number, number | null>();

    await Promise.allSettled([
      ...Array.from(lighterUserIds).map(async (userId) => {
        try {
          const config = await getBotConfig(userId);
          if (config.accountIndex === null) { lighterPnlMap.set(userId, null); return; }
          const accountRaw = await getAccountByIndex(config.accountIndex, config.network);
          if (!accountRaw?.accounts?.length) { lighterPnlMap.set(userId, null); return; }
          const positions: any[] = accountRaw.accounts[0].positions ?? [];
          const total = positions.reduce((sum, p) =>
            sum + parseFloat(p.unrealized_pnl ?? "0") + parseFloat(p.realized_pnl ?? "0"), 0);
          lighterPnlMap.set(userId, total);
        } catch { lighterPnlMap.set(userId, null); }
      }),

      ...Array.from(extendedUserIds).map(async (userId) => {
        try {
          const creds = await getExtendedCredentials(userId);
          if (!creds.apiKey) { extendedPnlMap.set(userId, null); return; }
          const network = (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork;
          const balance = await getBalance(creds.apiKey, network);
          if (!balance) { extendedPnlMap.set(userId, null); return; }
          extendedPnlMap.set(userId, parseFloat(balance.unrealisedPnl ?? "0"));
        } catch { extendedPnlMap.set(userId, null); }
      }),
    ]);

    res.json({
      strategies: strategies.map((s) => {
        const user = s.userId ? userMap.get(s.userId) : null;
        const isRunning =
          lighterRunning.has(s.id) ||
          extendedRunning.has(s.id);

        let livePnl: number | null = null;
        if (s.userId != null && isRunning) {
          if (s.exchange === "lighter") livePnl = lighterPnlMap.get(s.userId) ?? null;
          else if (s.exchange === "extended") livePnl = extendedPnlMap.get(s.userId) ?? null;
        }

        return {
          id: s.id,
          name: s.name,
          type: s.type,
          exchange: s.exchange,
          marketSymbol: s.marketSymbol,
          isActive: s.isActive,
          isRunning,
          realizedPnl: parseFloat(s.realizedPnl ?? "0"),
          livePnl,
          livePnlSource: livePnl !== null ? ("exchange" as const) : null,
          totalOrders: s.totalOrders,
          successfulOrders: s.successfulOrders,
          updatedAt: s.updatedAt.toISOString(),
          user: user ? {
            id: user.id,
            telegramName: user.telegramName,
            telegramUsername: user.telegramUsername,
            telegramId: user.telegramId,
          } : null,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get strategies" });
  }
});

router.get("/payments", async (_req, res) => {
  try {
    const payments = await db.query.pendingPaymentsTable.findMany({
      orderBy: [desc(pendingPaymentsTable.createdAt)],
    });
    res.json({
      payments: payments.map((p) => ({
        id: p.id,
        donationId: p.donationId,
        telegramId: p.telegramId,
        telegramName: p.telegramName,
        telegramUsername: p.telegramUsername,
        plan: p.plan,
        amount: parseFloat(p.amount),
        expiresAt: p.expiresAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        status: p.status,
        retryCount: p.retryCount,
        lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
        lastSaweriaResponse: p.lastSaweriaResponse ?? null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get payments" });
  }
});

// ─── BROADCAST: Start ─────────────────────────────────────────────────────────
router.post("/broadcast", async (req, res) => {
  const { message, parseMode, disableWebPagePreview, targetFilter } = req.body as {
    message: string;
    parseMode?: "HTML" | "MarkdownV2" | "Markdown";
    disableWebPagePreview?: boolean;
    targetFilter?: "all" | "active";
  };
  if (!message?.trim()) {
    return res.status(400).json({ error: "Pesan tidak boleh kosong" });
  }
  try {
    // Ambil semua kontak dari NeonDB (semua yang pernah /start)
    const neonContacts = await getActiveBroadcastContacts();

    let targets: string[];

    if (targetFilter === "active") {
      // Filter: hanya NeonDB contacts yang juga subscriber aktif (belum expired) di DB utama
      // Hanya baca dari usersTable, tidak ada write sama sekali
      const activeUsers = await db.query.usersTable.findMany({
        where: (u, { and, eq, gt: grtOp }) => and(eq(u.isActive, true), grtOp(u.expiresAt, new Date())),
        columns: { telegramId: true },
      });
      const activeIds = new Set(activeUsers.map((u) => u.telegramId));
      targets = neonContacts.filter((chatId) => activeIds.has(chatId));
    } else {
      // "all" → semua NeonDB contacts (semua yang pernah /start, subscriber maupun bukan)
      targets = neonContacts;
    }

    const job = await broadcaster.enqueue({
      message: message.trim(),
      parseMode: parseMode ?? "HTML",
      disableWebPagePreview: disableWebPagePreview ?? true,
      targetFilter: targetFilter ?? "all",
      targets,
    });
    res.json({ jobId: job.id, total: job.total, status: job.status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Gagal memulai broadcast" });
  }
});

// ─── BROADCAST: Status per job ────────────────────────────────────────────────
router.get("/broadcast/status/:jobId", (req, res) => {
  const job = broadcaster.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan" });
  res.json(job);
});

// ─── BROADCAST: Latest job status ─────────────────────────────────────────────
router.get("/broadcast/status", (_req, res) => {
  const job = broadcaster.getLatest();
  res.json(job ?? { status: "idle" });
});

// ─── BROADCAST: History (last 20 jobs) ────────────────────────────────────────
router.get("/broadcast/history", (_req, res) => {
  res.json({ jobs: broadcaster.getAll(), stats: broadcaster.getStats() });
});

// ─── BROADCAST: Cancel ────────────────────────────────────────────────────────
router.delete("/broadcast/cancel", (req, res) => {
  const { jobId } = req.body as { jobId?: string };
  const cancelled = broadcaster.cancel(jobId);
  res.json({ cancelled, message: cancelled ? "Broadcast dibatalkan" : "Tidak ada broadcast yang aktif" });
});

// ─── BROADCAST: Entity type reference ─────────────────────────────────────────
router.get("/broadcast/entities", (_req, res) => {
  res.json({ entities: ENTITY_EXAMPLES });
});

// ─── BOT CONTROL (emergency stop/start dari admin panel) ──────────────────────
router.post("/bot/stop/:strategyId", async (req, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
    columns: { id: true, exchange: true },
  });
  if (!strategy) return res.status(404).json({ error: "Strategy tidak ditemukan" });

  try {
    if (strategy.exchange === "lighter") {
      await stopBot(strategyId);
    } else {
      await stopExtendedBot(strategyId);
    }
    res.json({ ok: true, strategyId, action: "stop" });
  } catch (err) {
    req.log.error({ err, strategyId }, "[Admin] Failed to stop bot");
    res.status(500).json({ error: "Gagal menghentikan bot" });
  }
});

router.post("/bot/start/:strategyId", async (req, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
    columns: { id: true, exchange: true },
  });
  if (!strategy) return res.status(404).json({ error: "Strategy tidak ditemukan" });

  try {
    let success = false;
    if (strategy.exchange === "lighter") {
      success = (await startBot(strategyId)) !== false;
    } else {
      success = await startExtendedBot(strategyId);
    }
    if (!success) return res.status(409).json({ error: "Bot gagal distart (credentials missing atau sudah running)" });
    res.json({ ok: true, strategyId, action: "start" });
  } catch (err) {
    req.log.error({ err, strategyId }, "[Admin] Failed to start bot");
    res.status(500).json({ error: "Gagal memulai bot" });
  }
});

// ─── NEON BROADCAST CONTACTS ──────────────────────────────────────────────────

// GET /admin/broadcast/contacts — list semua chatId + jumlahnya
router.get("/broadcast/contacts", async (_req, res) => {
  try {
    const contacts = await getActiveBroadcastContacts();
    const count = contacts.length;
    res.json({ count, contacts });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Gagal ambil contacts" });
  }
});

// GET /admin/broadcast/contacts/count — hanya jumlah
router.get("/broadcast/contacts/count", async (_req, res) => {
  try {
    const count = await getBroadcastContactCount();
    res.json({ count });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Gagal ambil count" });
  }
});

// POST /admin/broadcast/contacts — tambah/update satu chatId
router.post("/broadcast/contacts", async (req, res) => {
  const { chatId } = req.body as { chatId?: string };
  if (!chatId?.trim()) return res.status(400).json({ error: "chatId wajib diisi" });
  try {
    await upsertBroadcastContact(chatId.trim());
    res.json({ ok: true, chatId: chatId.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Gagal tambah contact" });
  }
});

// DELETE /admin/broadcast/contacts/:chatId — hapus satu chatId
router.delete("/broadcast/contacts/:chatId", async (req, res) => {
  const chatId = req.params.chatId;
  if (!chatId) return res.status(400).json({ error: "chatId wajib diisi" });
  try {
    await removeBroadcastContact(chatId);
    res.json({ ok: true, chatId });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Gagal hapus contact" });
  }
});

export default router;
