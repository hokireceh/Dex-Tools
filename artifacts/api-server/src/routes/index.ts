import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./lighter/market";
import configRouter from "./config";
import botRouter from "./lighter/bot";
import tradesRouter from "./trades";
import historyRouter from "./lighter/history";
import adminRouter from "./admin";
import authRouter from "./auth";
import aiRouter from "./ai";
import extendedBotRouter from "./extended/bot";
import extendedFrArbRouter from "./extended/frArb";
import lighterFrArbRouter from "./lighter/frArb";
import { adminMiddleware } from "../middlewares/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/market", marketRouter);
router.use("/config", configRouter);
router.use("/bot", botRouter);
router.use("/trades", tradesRouter);
router.use("/history", historyRouter);
router.use("/ai", aiRouter);
router.use("/admin", adminMiddleware, adminRouter);

// Extended DEX routes — additive only, tidak mengubah route Lighter
router.use("/extended/strategies", extendedBotRouter);

// FR Arb routes (Lighter + Extended)
router.use("/lighter/fr-arb", lighterFrArbRouter);
router.use("/extended/fr-arb", extendedFrArbRouter);

export default router;
