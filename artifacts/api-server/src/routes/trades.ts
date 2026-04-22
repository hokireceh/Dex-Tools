import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { desc, eq, and } from "drizzle-orm";
import { authMiddleware, type AuthRequest } from "../middlewares/auth";

const router = Router();
router.use(authMiddleware);

router.get("/", async (req: AuthRequest, res) => {
  const strategyId = req.query.strategyId ? parseInt(String(req.query.strategyId)) : undefined;
  const limit = parseInt(String(req.query.limit ?? "50"));

  try {
    const trades = await db.query.tradesTable.findMany({
      where: and(
        eq(tradesTable.userId, req.userId!),
        strategyId !== undefined ? eq(tradesTable.strategyId, strategyId) : undefined
      ),
      orderBy: [desc(tradesTable.createdAt)],
      limit: Math.min(limit, 500),
    });

    res.json({
      trades: trades.map((t) => ({
        id: t.id,
        strategyId: t.strategyId,
        strategyName: t.strategyName,
        marketIndex: t.marketIndex,
        marketSymbol: t.marketSymbol,
        side: t.side,
        size: t.size != null ? String(t.size) : undefined,
        price: t.price != null ? String(t.price) : undefined,
        fee: t.fee != null ? String(t.fee) : undefined,
        status: t.status,
        orderHash: t.orderHash ?? null,
        clientOrderIndex: t.clientOrderIndex ?? null,
        errorMessage: t.errorMessage ?? null,
        executedAt: t.executedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        exchange: (t.exchange ?? "lighter") as "lighter" | "extended",
      })),
      total: trades.length,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get trades");
    res.status(500).json({ error: "Failed to get trades" });
  }
});

export default router;
