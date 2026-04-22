import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../lib/encrypt";
import type { Network } from "../lib/lighter/lighterApi";
import type { ExtendedNetwork } from "../lib/extended/extendedApi";

const CONFIG_KEYS = {
  ACCOUNT_INDEX: "account_index",
  API_KEY_INDEX: "api_key_index",
  PRIVATE_KEY: "private_key",
  NETWORK: "network",
  L1_ADDRESS: "l1_address",
  NOTIFY_ON_BUY: "notify_on_buy",
  NOTIFY_ON_SELL: "notify_on_sell",
  NOTIFY_ON_ERROR: "notify_on_error",
  NOTIFY_ON_START: "notify_on_start",
  NOTIFY_ON_STOP: "notify_on_stop",
  NOTIFY_BOT_TOKEN: "notify_bot_token",
  NOTIFY_CHAT_ID: "notify_chat_id",
  LIGHTER_READONLY_TOKEN: "lighter_readonly_token",
};

// ── Extended DEX credential keys (stored in bot_config, NOT in users table) ──
const EXT_KEYS = {
  API_KEY: "ext_api_key",
  STARK_PRIVATE_KEY: "ext_stark_private_key",
  ACCOUNT_ID: "ext_account_id",
  NETWORK: "ext_network",
};


const ENCRYPTED_KEYS = new Set([
  CONFIG_KEYS.PRIVATE_KEY,
  CONFIG_KEYS.NOTIFY_BOT_TOKEN,
  EXT_KEYS.API_KEY,
  EXT_KEYS.STARK_PRIVATE_KEY,
]);

async function getConfigValue(userId: number, key: string): Promise<string | null> {
  const row = await db.query.botConfigTable.findFirst({
    where: and(eq(botConfigTable.userId, userId), eq(botConfigTable.key, key)),
  });
  if (!row?.value) return null;
  if (!ENCRYPTED_KEYS.has(key)) return row.value;
  // BUG-ENC-001: wrap decrypt so auth-tag failures (key rotation, corruption)
  // surface with userId+key context instead of a bare Node crypto error.
  try {
    return decrypt(row.value);
  } catch (err: any) {
    throw new Error(
      `[configService] decrypt failed — userId=${userId} key=${key}: ${err?.message ?? "unknown error"}`
    );
  }
}

async function setConfigValue(userId: number, key: string, value: string) {
  const storedValue = ENCRYPTED_KEYS.has(key) ? encrypt(value) : value;
  const now = new Date();
  await db.insert(botConfigTable)
    .values({ userId, key, value: storedValue, updatedAt: now })
    .onConflictDoUpdate({
      target: [botConfigTable.userId, botConfigTable.key],
      set: { value: storedValue, updatedAt: now },
    });
}

async function deleteConfigValue(userId: number, key: string) {
  await db.delete(botConfigTable).where(
    and(eq(botConfigTable.userId, userId), eq(botConfigTable.key, key))
  );
}

export async function getBotConfig(userId: number) {
  // BUG-CFG-001: CONFIG_KEYS.NETWORK fetch removed — network is always "mainnet".
  // DB value was fetched but ignored (return hardcodes "mainnet" as const).
  // updateBotConfig still accepts network writes for future multi-network DEX support.
  const [accountIndex, apiKeyIndex, privateKey, l1Address,
    notifyOnBuy, notifyOnSell, notifyOnError, notifyOnStart, notifyOnStop,
    notifyBotToken, notifyChatId, lighterReadonlyToken] = await Promise.all([
    getConfigValue(userId, CONFIG_KEYS.ACCOUNT_INDEX),
    getConfigValue(userId, CONFIG_KEYS.API_KEY_INDEX),
    getConfigValue(userId, CONFIG_KEYS.PRIVATE_KEY),
    getConfigValue(userId, CONFIG_KEYS.L1_ADDRESS),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_BUY),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_SELL),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_ERROR),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_START),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_STOP),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_BOT_TOKEN),
    getConfigValue(userId, CONFIG_KEYS.NOTIFY_CHAT_ID),
    getConfigValue(userId, CONFIG_KEYS.LIGHTER_READONLY_TOKEN),
  ]);

  const effectiveNotifyBotToken = notifyBotToken || process.env.BOT_TOKEN || null;
  const effectiveNotifyChatId = notifyChatId || process.env.ADMIN_CHAT_ID || null;

  return {
    accountIndex: accountIndex !== null ? parseInt(accountIndex) : null,
    apiKeyIndex: apiKeyIndex !== null ? parseInt(apiKeyIndex) : null,
    privateKey,
    network: "mainnet" as const,
    l1Address,
    lighterReadonlyToken,
    hasPrivateKey: !!privateKey,
    notifyOnBuy: notifyOnBuy !== null ? notifyOnBuy === "true" : true,
    notifyOnSell: notifyOnSell !== null ? notifyOnSell === "true" : true,
    notifyOnError: notifyOnError !== null ? notifyOnError === "true" : true,
    notifyOnStart: notifyOnStart !== null ? notifyOnStart === "true" : true,
    notifyOnStop: notifyOnStop !== null ? notifyOnStop === "true" : false,
    notifyBotToken: effectiveNotifyBotToken,
    notifyChatId: effectiveNotifyChatId,
    hasNotifyBotToken: !!effectiveNotifyBotToken,
  };
}

export async function getNotificationConfig(userId: number) {
  const config = await getBotConfig(userId);
  return {
    notifyOnBuy: config.notifyOnBuy,
    notifyOnSell: config.notifyOnSell,
    notifyOnError: config.notifyOnError,
    notifyOnStart: config.notifyOnStart,
    notifyOnStop: config.notifyOnStop,
  };
}

// ─── Extended DEX credentials (stored in bot_config key-value table) ─────────

export async function getExtendedCredentials(userId: number) {
  const [apiKey, privateKey, accountId, network] = await Promise.all([
    getConfigValue(userId, EXT_KEYS.API_KEY),
    getConfigValue(userId, EXT_KEYS.STARK_PRIVATE_KEY),
    getConfigValue(userId, EXT_KEYS.ACCOUNT_ID),
    getConfigValue(userId, EXT_KEYS.NETWORK),
  ]);
  return {
    apiKey,
    privateKey,
    accountId,
    extendedNetwork: "mainnet" as const,
    hasApiKey: !!apiKey,
    hasPrivateKey: !!privateKey,
    hasAccountId: !!accountId,
    hasCredentials: !!(apiKey && privateKey && accountId),
  };
}

export async function updateExtendedCredentials(userId: number, updates: {
  apiKey?: string | null;
  privateKey?: string | null;
  accountId?: string | null;
  extendedNetwork?: "mainnet";
}) {
  const promises: Promise<void>[] = [];

  if (updates.apiKey !== undefined) {
    promises.push(
      updates.apiKey
        ? setConfigValue(userId, EXT_KEYS.API_KEY, updates.apiKey)
        : deleteConfigValue(userId, EXT_KEYS.API_KEY)
    );
  }
  if (updates.privateKey !== undefined) {
    promises.push(
      updates.privateKey
        ? setConfigValue(userId, EXT_KEYS.STARK_PRIVATE_KEY, updates.privateKey)
        : deleteConfigValue(userId, EXT_KEYS.STARK_PRIVATE_KEY)
    );
  }
  if (updates.accountId !== undefined) {
    promises.push(
      updates.accountId
        ? setConfigValue(userId, EXT_KEYS.ACCOUNT_ID, updates.accountId)
        : deleteConfigValue(userId, EXT_KEYS.ACCOUNT_ID)
    );
  }
  if (updates.extendedNetwork !== undefined) {
    promises.push(setConfigValue(userId, EXT_KEYS.NETWORK, updates.extendedNetwork));
  }

  await Promise.all(promises);
}

export async function deleteExtendedCredentials(userId: number) {
  await Promise.all(
    Object.values(EXT_KEYS).map((key) => deleteConfigValue(userId, key))
  );
}



export async function deleteLighterCredentials(userId: number) {
  await Promise.all([
    deleteConfigValue(userId, CONFIG_KEYS.PRIVATE_KEY),
    deleteConfigValue(userId, CONFIG_KEYS.API_KEY_INDEX),
    deleteConfigValue(userId, CONFIG_KEYS.ACCOUNT_INDEX),
    deleteConfigValue(userId, CONFIG_KEYS.L1_ADDRESS),
    deleteConfigValue(userId, CONFIG_KEYS.LIGHTER_READONLY_TOKEN),
  ]);
}

export async function updateBotConfig(userId: number, updates: {
  accountIndex?: number | null;
  apiKeyIndex?: number | null;
  privateKey?: string | null;
  network?: "mainnet";
  l1Address?: string | null;
  lighterReadonlyToken?: string | null;
  notifyOnBuy?: boolean | null;
  notifyOnSell?: boolean | null;
  notifyOnError?: boolean | null;
  notifyOnStart?: boolean | null;
  notifyOnStop?: boolean | null;
  notifyBotToken?: string | null;
  notifyChatId?: string | null;
}) {
  const promises: Promise<void>[] = [];

  if (updates.accountIndex !== undefined) {
    promises.push(
      updates.accountIndex !== null
        ? setConfigValue(userId, CONFIG_KEYS.ACCOUNT_INDEX, String(updates.accountIndex))
        : deleteConfigValue(userId, CONFIG_KEYS.ACCOUNT_INDEX)
    );
  }
  if (updates.apiKeyIndex !== undefined) {
    promises.push(
      updates.apiKeyIndex !== null
        ? setConfigValue(userId, CONFIG_KEYS.API_KEY_INDEX, String(updates.apiKeyIndex))
        : deleteConfigValue(userId, CONFIG_KEYS.API_KEY_INDEX)
    );
  }
  if (updates.privateKey !== undefined) {
    promises.push(
      updates.privateKey !== null
        ? setConfigValue(userId, CONFIG_KEYS.PRIVATE_KEY, updates.privateKey)
        : deleteConfigValue(userId, CONFIG_KEYS.PRIVATE_KEY)
    );
  }
  if (updates.network !== undefined) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NETWORK, updates.network));
  }
  if (updates.l1Address !== undefined) {
    promises.push(
      updates.l1Address !== null
        ? setConfigValue(userId, CONFIG_KEYS.L1_ADDRESS, updates.l1Address)
        : deleteConfigValue(userId, CONFIG_KEYS.L1_ADDRESS)
    );
  }
  if (updates.lighterReadonlyToken !== undefined) {
    promises.push(
      updates.lighterReadonlyToken !== null
        ? setConfigValue(userId, CONFIG_KEYS.LIGHTER_READONLY_TOKEN, updates.lighterReadonlyToken)
        : deleteConfigValue(userId, CONFIG_KEYS.LIGHTER_READONLY_TOKEN)
    );
  }
  if (updates.notifyOnBuy !== undefined && updates.notifyOnBuy !== null) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_BUY, String(updates.notifyOnBuy)));
  }
  if (updates.notifyOnSell !== undefined && updates.notifyOnSell !== null) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_SELL, String(updates.notifyOnSell)));
  }
  if (updates.notifyOnError !== undefined && updates.notifyOnError !== null) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_ERROR, String(updates.notifyOnError)));
  }
  if (updates.notifyOnStart !== undefined && updates.notifyOnStart !== null) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_START, String(updates.notifyOnStart)));
  }
  if (updates.notifyOnStop !== undefined && updates.notifyOnStop !== null) {
    promises.push(setConfigValue(userId, CONFIG_KEYS.NOTIFY_ON_STOP, String(updates.notifyOnStop)));
  }
  if (updates.notifyBotToken !== undefined) {
    promises.push(
      updates.notifyBotToken
        ? setConfigValue(userId, CONFIG_KEYS.NOTIFY_BOT_TOKEN, updates.notifyBotToken)
        : deleteConfigValue(userId, CONFIG_KEYS.NOTIFY_BOT_TOKEN)
    );
  }
  if (updates.notifyChatId !== undefined) {
    promises.push(
      updates.notifyChatId
        ? setConfigValue(userId, CONFIG_KEYS.NOTIFY_CHAT_ID, updates.notifyChatId)
        : deleteConfigValue(userId, CONFIG_KEYS.NOTIFY_CHAT_ID)
    );
  }

  await Promise.all(promises);
  return getBotConfig(userId);
}
