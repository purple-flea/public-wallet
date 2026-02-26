import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import type { AppEnv } from "../types.js";
import { randomUUID } from "crypto";

const alerts = new Hono<AppEnv>();
alerts.use("*", authMiddleware);

const MAX_ALERTS_PER_AGENT = 20;

// CoinGecko IDs for supported coins
const COIN_IDS: Record<string, string> = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  ethereum: "ethereum",
  eth: "ethereum",
  solana: "solana",
  sol: "solana",
  tron: "tron",
  trx: "tron",
  usdc: "usd-coin",
  usdt: "tether",
  bnb: "binancecoin",
  avax: "avalanche-2",
  matic: "matic-network",
  polygon: "matic-network",
  link: "chainlink",
  uni: "uniswap",
  aave: "aave",
  doge: "dogecoin",
  shib: "shiba-inu",
  xrp: "ripple",
  ada: "cardano",
  dot: "polkadot",
};

function normalizeCoin(input: string): string | null {
  const lower = input.toLowerCase().trim();
  return COIN_IDS[lower] ?? null;
}

async function fetchPrices(coinIds: string[]): Promise<Record<string, number>> {
  if (coinIds.length === 0) return {};
  try {
    const ids = [...new Set(coinIds)].join(",");
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json() as Record<string, { usd: number }>;
    const result: Record<string, number> = {};
    for (const [id, priceData] of Object.entries(data)) {
      result[id] = priceData.usd;
    }
    return result;
  } catch {
    return {};
  }
}

// ─── POST / — create a price alert ───

alerts.post("/", async (c) => {
  const agentId = c.get("agentId") as string;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be valid JSON" }, 400);
  }

  const coinInput = body.coin as string;
  const condition = (body.condition as string)?.toLowerCase();
  const targetPrice = parseFloat(body.target_price ?? body.targetPrice ?? "0");
  const note = (body.note as string | undefined)?.slice(0, 100);

  if (!coinInput) return c.json({ error: "missing_coin", message: "Provide coin: bitcoin, ethereum, solana, etc." }, 400);
  if (condition !== "above" && condition !== "below") {
    return c.json({ error: "invalid_condition", message: "condition must be 'above' or 'below'" }, 400);
  }
  if (!targetPrice || targetPrice <= 0) {
    return c.json({ error: "invalid_price", message: "target_price must be a positive number" }, 400);
  }

  const coinId = normalizeCoin(coinInput);
  if (!coinId) {
    return c.json({
      error: "unsupported_coin",
      message: `Unknown coin: ${coinInput}`,
      supported_coins: Object.keys(COIN_IDS).filter(k => COIN_IDS[k] !== COIN_IDS[k.substring(0, 2)] || k.length > 3),
    }, 400);
  }

  // Count existing active alerts
  const existing = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.agentId, agentId),
      eq(schema.priceAlerts.status, "active"),
    ))
    .get();

  if ((existing?.count ?? 0) >= MAX_ALERTS_PER_AGENT) {
    return c.json({
      error: "too_many_alerts",
      message: `Max ${MAX_ALERTS_PER_AGENT} active alerts per agent. Delete some first.`,
    }, 400);
  }

  // Fetch current price for context
  const prices = await fetchPrices([coinId]);
  const currentPrice = prices[coinId] ?? null;

  const id = `alert_${randomUUID().slice(0, 12)}`;
  db.insert(schema.priceAlerts).values({
    id,
    agentId,
    coin: coinId,
    condition,
    targetPrice,
    status: "active",
    note: note ?? null,
  }).run();

  return c.json({
    id,
    coin: coinId,
    condition,
    target_price: targetPrice,
    current_price: currentPrice,
    distance_pct: currentPrice
      ? parseFloat(Math.abs((targetPrice - currentPrice) / currentPrice * 100).toFixed(2))
      : null,
    note: note ?? null,
    status: "active",
    message: `Alert set: notify when ${coinId} goes ${condition} $${targetPrice.toLocaleString()}`,
    check_via: "GET /v1/alerts/check — polls current prices and returns triggered alerts",
    created_at: new Date().toISOString(),
  }, 201);
});

// ─── GET / — list all alerts ───

alerts.get("/", async (c) => {
  const agentId = c.get("agentId") as string;
  const statusFilter = c.req.query("status"); // optional: active | triggered

  const rows = db.select()
    .from(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.agentId, agentId),
      ...(statusFilter ? [eq(schema.priceAlerts.status, statusFilter)] : []),
    ))
    .orderBy(schema.priceAlerts.createdAt)
    .all();

  // Fetch current prices for active alerts
  const activeCoins = [...new Set(rows.filter(r => r.status === "active").map(r => r.coin))];
  const prices = await fetchPrices(activeCoins);

  return c.json({
    total: rows.length,
    active: rows.filter(r => r.status === "active").length,
    triggered: rows.filter(r => r.status === "triggered").length,
    alerts: rows.map(r => ({
      id: r.id,
      coin: r.coin,
      condition: r.condition,
      target_price: r.targetPrice,
      current_price: prices[r.coin] ?? null,
      distance_pct: (prices[r.coin] && r.status === "active")
        ? parseFloat(Math.abs((r.targetPrice - prices[r.coin]) / prices[r.coin] * 100).toFixed(2))
        : null,
      status: r.status,
      note: r.note,
      triggered_at: r.triggeredAt ? new Date(r.triggeredAt * 1000).toISOString() : null,
      triggered_price: r.triggeredPrice,
      created_at: new Date(r.createdAt * 1000).toISOString(),
    })),
    supported_coins: Object.keys(COIN_IDS).filter((_, i) => i < 15),
  });
});

// ─── GET /check — check all active alerts against live prices ───

alerts.get("/check", async (c) => {
  const agentId = c.get("agentId") as string;
  c.header("Cache-Control", "no-cache");

  const activeAlerts = db.select()
    .from(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.agentId, agentId),
      eq(schema.priceAlerts.status, "active"),
    ))
    .all();

  if (activeAlerts.length === 0) {
    return c.json({
      triggered: [],
      active_remaining: 0,
      message: "No active alerts. Create one at POST /v1/alerts",
    });
  }

  const coinIds = [...new Set(activeAlerts.map(a => a.coin))];
  const prices = await fetchPrices(coinIds);

  const triggered: typeof activeAlerts = [];
  const stillActive: typeof activeAlerts = [];

  for (const alert of activeAlerts) {
    const currentPrice = prices[alert.coin];
    if (currentPrice === undefined) {
      stillActive.push(alert);
      continue;
    }

    const isTriggered = alert.condition === "above"
      ? currentPrice >= alert.targetPrice
      : currentPrice <= alert.targetPrice;

    if (isTriggered) {
      // Mark as triggered
      db.update(schema.priceAlerts)
        .set({
          status: "triggered",
          triggeredAt: Math.floor(Date.now() / 1000),
          triggeredPrice: currentPrice,
        })
        .where(eq(schema.priceAlerts.id, alert.id))
        .run();
      triggered.push({ ...alert, triggeredPrice: currentPrice });
    } else {
      stillActive.push(alert);
    }
  }

  return c.json({
    triggered_count: triggered.length,
    active_remaining: stillActive.length,
    triggered: triggered.map(a => ({
      id: a.id,
      coin: a.coin,
      condition: a.condition,
      target_price: a.targetPrice,
      triggered_price: a.triggeredPrice,
      note: a.note,
      message: `${a.coin} is ${a.condition} $${a.targetPrice.toLocaleString()} (current: $${a.triggeredPrice?.toLocaleString()})`,
    })),
    active: stillActive.map(a => ({
      id: a.id,
      coin: a.coin,
      condition: a.condition,
      target_price: a.targetPrice,
      current_price: prices[a.coin] ?? null,
      distance_pct: prices[a.coin]
        ? parseFloat(Math.abs((a.targetPrice - prices[a.coin]) / prices[a.coin] * 100).toFixed(2))
        : null,
    })),
    prices_fetched: prices,
    checked_at: new Date().toISOString(),
  });
});

// ─── DELETE /:id — delete an alert ───

alerts.delete("/:id", async (c) => {
  const agentId = c.get("agentId") as string;
  const alertId = c.req.param("id");

  const existing = db.select()
    .from(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.id, alertId),
      eq(schema.priceAlerts.agentId, agentId),
    ))
    .get();

  if (!existing) {
    return c.json({ error: "not_found", message: "Alert not found or doesn't belong to you" }, 404);
  }

  db.delete(schema.priceAlerts)
    .where(eq(schema.priceAlerts.id, alertId))
    .run();

  return c.json({ success: true, message: `Alert ${alertId} deleted` });
});

export default alerts;
