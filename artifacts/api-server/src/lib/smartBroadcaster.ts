import { Telegraf } from "telegraf";
import { logger } from "./logger";
import {
  getActiveBroadcastContacts,
  removeBroadcastContact,
} from "./neonBroadcastDb";

// ─── Rate Limiting Constants ─────────────────────────────────────────────────
// Telegram allows max 30 messages/second globally, but to be safe we use 20/s
const RATE_LIMIT_MS = 50;        // 1 message per 50ms = 20 msg/sec
const BATCH_SIZE = 20;            // send 20, then pause
const INTER_BATCH_DELAY_MS = 1000; // 1s pause between batches

// ─── Circuit Breaker Constants ────────────────────────────────────────────────
const CB_FAILURE_THRESHOLD = 5;   // open circuit after 5 consecutive failures
const CB_RECOVERY_MS = 30_000;    // try again after 30s (half-open)

// ─── 18 Supported Entity Types (HTML parse_mode) ─────────────────────────────
export const ENTITY_EXAMPLES = {
  bold:               { tag: "b",              label: "Bold",              example: "<b>teks tebal</b>" },
  italic:             { tag: "i",              label: "Italic",            example: "<i>teks miring</i>" },
  underline:          { tag: "u",              label: "Underline",         example: "<u>teks garis bawah</u>" },
  strikethrough:      { tag: "s",              label: "Strikethrough",     example: "<s>teks coret</s>" },
  spoiler:            { tag: "tg-spoiler",     label: "Spoiler",           example: "<tg-spoiler>teks tersembunyi</tg-spoiler>" },
  code:               { tag: "code",           label: "Code Inline",       example: "<code>kode inline</code>" },
  pre:                { tag: "pre",            label: "Pre Block",         example: "<pre>blok kode</pre>" },
  pre_lang:           { tag: "pre",            label: "Code Block",        example: '<pre language="python">print("hi")</pre>' },
  text_link:          { tag: "a",              label: "Link",              example: '<a href="https://example.com">teks link</a>' },
  mention:            { tag: "mention",        label: "Mention",           example: "@username" },
  hashtag:            { tag: "hashtag",        label: "Hashtag",           example: "#hashtag" },
  cashtag:            { tag: "cashtag",        label: "Cashtag",           example: "$BTC" },
  bot_command:        { tag: "bot_command",    label: "Bot Command",       example: "/command" },
  url:                { tag: "url",            label: "URL (auto)",        example: "https://example.com" },
  email:              { tag: "email",          label: "Email (auto)",      example: "user@example.com" },
  phone_number:       { tag: "phone",          label: "Phone (auto)",      example: "+62812345678" },
  blockquote:         { tag: "blockquote",     label: "Blockquote",        example: "<blockquote>kutipan teks</blockquote>" },
  expandable_blockquote: { tag: "blockquote", label: "Blockquote Expand", example: '<blockquote expandable>teks panjang yang bisa diklik</blockquote>' },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BroadcastParseMode = "HTML" | "MarkdownV2" | "Markdown";
export type BroadcastStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface BroadcastError {
  chatId: string;
  error: string;
}

export interface BroadcastJob {
  id: string;
  message: string;
  parseMode: BroadcastParseMode;
  disableWebPagePreview: boolean;
  targetFilter: "all" | "active";
  targets: string[];
  status: BroadcastStatus;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  lastErrors: BroadcastError[];
  circuitBreakerState: "closed" | "open" | "half-open";
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveFailures = 0;
  private lastOpenedAt = 0;

  isOpen(): boolean {
    if (this.state === "open") {
      if (Date.now() - this.lastOpenedAt >= CB_RECOVERY_MS) {
        this.state = "half-open";
        logger.info("[Broadcast CB] Half-open — attempting recovery");
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.state = "closed";
      logger.info("[Broadcast CB] Closed — circuit recovered");
    }
  }

  recordFailure() {
    this.consecutiveFailures++;
    this.lastOpenedAt = Date.now();
    if (this.consecutiveFailures >= CB_FAILURE_THRESHOLD && this.state !== "open") {
      this.state = "open";
      logger.warn({ threshold: CB_FAILURE_THRESHOLD }, "[Broadcast CB] Open — too many consecutive failures");
    }
  }

  getState(): "closed" | "open" | "half-open" {
    return this.state;
  }

  reset() {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }
}

// ─── Smart Broadcaster ────────────────────────────────────────────────────────

class SmartBroadcaster {
  private jobs = new Map<string, BroadcastJob>();
  private queue: string[] = [];
  private activeJobId: string | null = null;
  private telegram: Telegraf["telegram"] | null = null;
  private cb = new CircuitBreaker();

  // Keep last 20 jobs in memory
  private readonly MAX_HISTORY = 20;

  setTelegram(telegram: Telegraf["telegram"]) {
    this.telegram = telegram;
  }

  // ── Enqueue a new broadcast ────────────────────────────────────────────────
  async enqueue(opts: {
    message: string;
    parseMode?: BroadcastParseMode;
    disableWebPagePreview?: boolean;
    targetFilter?: "all" | "active";
    targets?: string[];
  }): Promise<BroadcastJob> {
    const id = `bcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Gunakan targets yang sudah difilter jika diberikan (dari admin route yang sudah pre-filter),
    // fallback ke semua NeonDB contacts jika dipanggil langsung tanpa targets.
    const targets = opts.targets !== undefined ? opts.targets : await getActiveBroadcastContacts();

    const job: BroadcastJob = {
      id,
      message: opts.message,
      parseMode: opts.parseMode ?? "HTML",
      disableWebPagePreview: opts.disableWebPagePreview ?? true,
      targetFilter: opts.targetFilter ?? "all",
      targets,
      status: "pending",
      sent: 0,
      failed: 0,
      skipped: 0,
      total: targets.length,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      lastErrors: [],
      circuitBreakerState: this.cb.getState(),
    };

    this.pruneHistory();
    this.jobs.set(id, job);
    this.queue.push(id);

    logger.info({ jobId: id, total: targets.length, parseMode: job.parseMode }, "[Broadcast] Job enqueued");

    // Kick off processing (non-blocking)
    this.processNext().catch(err => {
      logger.error({ err, jobId: id }, "[Broadcast] processNext threw unexpectedly");
    });

    return job;
  }

  // ── Cancel a job ──────────────────────────────────────────────────────────
  cancel(jobId?: string): boolean {
    const targetId = jobId ?? this.activeJobId;
    if (!targetId) return false;
    const job = this.jobs.get(targetId);
    if (!job) return false;
    if (job.status !== "pending" && job.status !== "running") return false;

    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    this.queue = this.queue.filter(id => id !== targetId);
    logger.info({ jobId: targetId }, "[Broadcast] Job cancelled");
    return true;
  }

  // ── Get job status ─────────────────────────────────────────────────────────
  getJob(jobId: string): BroadcastJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return { ...job, circuitBreakerState: this.cb.getState() };
  }

  // ── Get current/latest job ─────────────────────────────────────────────────
  getLatest(): BroadcastJob | null {
    if (this.activeJobId) {
      const job = this.jobs.get(this.activeJobId);
      if (job) return { ...job, circuitBreakerState: this.cb.getState() };
    }
    const all = Array.from(this.jobs.values());
    if (all.length === 0) return null;
    return { ...all[all.length - 1], circuitBreakerState: this.cb.getState() };
  }

  // ── Get all jobs (history) ─────────────────────────────────────────────────
  getAll(): BroadcastJob[] {
    return Array.from(this.jobs.values())
      .map(j => ({ ...j, circuitBreakerState: this.cb.getState() }))
      .reverse();
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats() {
    const all = Array.from(this.jobs.values());
    return {
      totalJobs: all.length,
      active: all.filter(j => j.status === "running").length,
      queued: this.queue.length,
      circuitBreaker: this.cb.getState(),
      totalSent: all.reduce((s, j) => s + j.sent, 0),
      totalFailed: all.reduce((s, j) => s + j.failed, 0),
    };
  }

  // ── Internal: process next job in queue ────────────────────────────────────
  private async processNext(): Promise<void> {
    if (this.activeJobId) return;
    if (this.queue.length === 0) return;

    const jobId = this.queue.shift()!;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") {
      return this.processNext();
    }

    await this.runJob(job);
    await this.processNext(); // process next in queue
  }

  // ── Internal: run a single broadcast job ──────────────────────────────────
  private async runJob(job: BroadcastJob): Promise<void> {
    if (!this.telegram) {
      job.status = "failed";
      logger.error({ jobId: job.id }, "[Broadcast] No Telegram client — job failed");
      return;
    }

    this.activeJobId = job.id;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.circuitBreakerState = this.cb.getState();

    logger.info({ jobId: job.id, total: job.total, parseMode: job.parseMode }, "[Broadcast] Job started");

    try {
      for (let i = 0; i < job.targets.length; i++) {
        // Check cancellation — cast to BroadcastStatus to avoid TS control-flow
        // narrowing: TS sees job.status = "running" above and narrows the type,
        // but cancel() can mutate it externally, so we widen it back here.
        if ((job.status as BroadcastStatus) === "cancelled") {
          logger.info({ jobId: job.id, sentSoFar: job.sent }, "[Broadcast] Job cancelled mid-run");
          break;
        }

        // Circuit breaker: if open, wait for recovery
        if (this.cb.isOpen()) {
          logger.warn({ jobId: job.id }, "[Broadcast] Circuit breaker open — waiting 30s");
          await sleep(CB_RECOVERY_MS);
        }

        const chatId = job.targets[i];

        try {
          await this.telegram.sendMessage(chatId, job.message, {
            parse_mode: job.parseMode,
            link_preview_options: job.disableWebPagePreview ? { is_disabled: true } : undefined,
          });
          this.cb.recordSuccess();
          job.sent++;
        } catch (err: any) {
          this.cb.recordFailure();
          job.failed++;
          const errMsg: string = err?.response?.description ?? err?.message ?? String(err);

          // Jika user block/hapus/tidak ditemukan → hapus dari NeonDB langsung, jangan hitung ke CB
          // "not found" sudah mencakup "chat not found"; "deactivated" mencakup "user is deactivated"
          const isUserGone =
            errMsg.includes("blocked") ||
            errMsg.includes("deactivated") ||
            errMsg.includes("not found") ||
            errMsg.includes("kicked");

          if (isUserGone) {
            this.cb.recordSuccess(); // undo the failure we just recorded
            this.cb.recordSuccess(); // mark as success for CB purposes
            job.skipped++;
            job.failed--;
            // Hapus permanen dari NeonDB — tidak akan dapat broadcast lagi
            removeBroadcastContact(chatId).catch(e =>
              logger.warn({ chatId, err: e?.message }, "[NeonBroadcast] Gagal hapus contact")
            );
          }

          if (job.lastErrors.length < 20) {
            job.lastErrors.push({ chatId, error: errMsg });
          }

          logger.warn({ chatId, jobId: job.id, err: errMsg, removed: isUserGone }, "[Broadcast] Failed to send to chat");
        }

        job.circuitBreakerState = this.cb.getState();

        // Rate limiting: wait between messages
        await sleep(RATE_LIMIT_MS);

        // Batch pause: after every BATCH_SIZE messages, longer pause
        if ((i + 1) % BATCH_SIZE === 0 && i + 1 < job.targets.length) {
          await sleep(INTER_BATCH_DELAY_MS);
        }
      }
    } catch (err: any) {
      logger.error({ err, jobId: job.id }, "[Broadcast] Unexpected error during job");
    } finally {
      if ((job.status as BroadcastStatus) !== "cancelled") {
        job.status = "completed";
      }
      job.completedAt = new Date().toISOString();
      this.activeJobId = null;

      logger.info(
        { jobId: job.id, sent: job.sent, failed: job.failed, skipped: job.skipped, status: job.status },
        "[Broadcast] Job finished"
      );
    }
  }

  // ── Prune old history ──────────────────────────────────────────────────────
  private pruneHistory() {
    const keys = Array.from(this.jobs.keys());
    while (keys.length >= this.MAX_HISTORY) {
      const oldest = keys.shift()!;
      if (this.activeJobId !== oldest) {
        this.jobs.delete(oldest);
      } else {
        break; // don't delete active job
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
export const broadcaster = new SmartBroadcaster();

// ─── Helper ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
