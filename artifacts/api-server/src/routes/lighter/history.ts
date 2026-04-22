import { Router } from "express";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth";
import { getBotConfig } from "../configService";
import {
  getTx,
  getTxFromL1TxHash,
  getDepositHistory,
  getTransferHistory,
  getWithdrawHistory,
} from "../../lib/lighter/lighterApi";

const router = Router();
router.use(authMiddleware);

router.get("/tx", async (req: AuthRequest, res) => {
  const by = String(req.query.by ?? "");
  const value = String(req.query.value ?? "");

  if (!["hash", "sequence_index"].includes(by) || !value) {
    return res.status(400).json({ error: "Query params 'by' (hash|sequence_index) and 'value' are required" });
  }

  try {
    const config = await getBotConfig(req.userId!);
    const result = await getTx(by as "hash" | "sequence_index", value, config.network);
    if (!result) return res.status(502).json({ error: "Failed to fetch transaction" });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tx");
    res.status(502).json({ error: "Failed to fetch transaction" });
  }
});

router.get("/tx-from-l1", async (req: AuthRequest, res) => {
  const hash = String(req.query.hash ?? "");
  if (!hash) return res.status(400).json({ error: "Query param 'hash' is required" });

  try {
    const config = await getBotConfig(req.userId!);
    const result = await getTxFromL1TxHash(hash, config.network);
    if (!result) return res.status(502).json({ error: "Failed to fetch transaction from L1 hash" });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tx from L1 hash");
    res.status(502).json({ error: "Failed to fetch transaction" });
  }
});

router.get("/deposits", async (req: AuthRequest, res) => {
  const authorization = String(req.query.authorization ?? req.headers["x-lighter-authorization"] ?? "");
  const cursor = String(req.query.cursor ?? "");
  const filter = req.query.filter as "all" | "pending" | "claimable" | undefined;

  try {
    const config = await getBotConfig(req.userId!);

    // ROUTE-LIGHTER-HISTORY-IDX-ZERO-001: strict null check — accountIndex=0 is valid
    // (sequential per L1 address per Lighter docs). Mirror fix ROUTE-LIGHTER-ACCOUNT-IDX-ZERO-001.
    if (config.accountIndex === null) {
      return res.status(400).json({ error: "Account index not configured" });
    }
    if (!config.l1Address) {
      return res.status(400).json({ error: "L1 address not configured" });
    }
    if (!authorization) {
      return res.status(400).json({ error: "Authorization is required (pass as ?authorization= or X-Lighter-Authorization header)" });
    }

    const result = await getDepositHistory({
      accountIndex: config.accountIndex,
      l1Address: config.l1Address,
      authorization,
      cursor: cursor || undefined,
      filter,
      network: config.network,
    });

    if (!result) return res.status(502).json({ error: "Failed to fetch deposit history" });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch deposit history");
    res.status(502).json({ error: "Failed to fetch deposit history" });
  }
});

router.get("/transfers", async (req: AuthRequest, res) => {
  const authorization = String(req.query.authorization ?? req.headers["x-lighter-authorization"] ?? "");
  const cursor = String(req.query.cursor ?? "");
  const typeParam = req.query.type;
  const types = Array.isArray(typeParam)
    ? typeParam.map(String)
    : typeParam
    ? [String(typeParam)]
    : undefined;

  try {
    const config = await getBotConfig(req.userId!);

    // ROUTE-LIGHTER-HISTORY-IDX-ZERO-001: strict null check — accountIndex=0 is valid.
    if (config.accountIndex === null) {
      return res.status(400).json({ error: "Account index not configured" });
    }

    const result = await getTransferHistory({
      accountIndex: config.accountIndex,
      authorization: authorization || undefined,
      cursor: cursor || undefined,
      type: types,
      network: config.network,
    });

    if (!result) return res.status(502).json({ error: "Failed to fetch transfer history" });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch transfer history");
    res.status(502).json({ error: "Failed to fetch transfer history" });
  }
});

router.get("/withdrawals", async (req: AuthRequest, res) => {
  const authorization = String(req.query.authorization ?? req.headers["x-lighter-authorization"] ?? "");
  const cursor = String(req.query.cursor ?? "");
  const filter = req.query.filter as "all" | "pending" | "claimable" | undefined;

  try {
    const config = await getBotConfig(req.userId!);

    // ROUTE-LIGHTER-HISTORY-IDX-ZERO-001: strict null check — accountIndex=0 is valid.
    if (config.accountIndex === null) {
      return res.status(400).json({ error: "Account index not configured" });
    }
    if (!authorization) {
      return res.status(400).json({ error: "Authorization is required (pass as ?authorization= or X-Lighter-Authorization header)" });
    }

    const result = await getWithdrawHistory({
      accountIndex: config.accountIndex,
      authorization,
      cursor: cursor || undefined,
      filter,
      network: config.network,
    });

    if (!result) return res.status(502).json({ error: "Failed to fetch withdrawal history" });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch withdrawal history");
    res.status(502).json({ error: "Failed to fetch withdrawal history" });
  }
});

export default router;
