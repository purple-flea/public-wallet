import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { AppEnv } from "../types.js";

const referral = new Hono<AppEnv>();
referral.use("/*", authMiddleware);

// GET /code — get agent's referral code
referral.get("/code", async (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  return c.json({
    referral_code: agent.referralCode,
    commission_rate: "10% of swap integrator fees from referred agents",
    share_message: `Sign up with referral_code: ${agent.referralCode}`,
  });
});

// GET /stats — referral earnings overview
referral.get("/stats", async (c) => {
  const agentId = c.get("agentId") as string;

  const referralsList = db
    .select()
    .from(schema.referrals)
    .where(eq(schema.referrals.referrerId, agentId))
    .all();

  const totalEarned = referralsList.reduce((sum, r) => sum + r.totalEarned, 0);

  // Calculate pending balance (earned but not withdrawn)
  const withdrawals = db
    .select()
    .from(schema.referralWithdrawals)
    .where(eq(schema.referralWithdrawals.referrerId, agentId))
    .all();
  const totalWithdrawn = withdrawals
    .filter((w) => w.status === "completed")
    .reduce((sum, w) => sum + w.amount, 0);

  return c.json({
    total_referrals: referralsList.length,
    total_earned_usd: Math.round(totalEarned * 100) / 100,
    total_withdrawn_usd: Math.round(totalWithdrawn * 100) / 100,
    available_usd: Math.round((totalEarned - totalWithdrawn) * 100) / 100,
    commission_rate: "10% of swap fees",
    referrals: referralsList.map((r) => ({
      referred_agent: r.referredId,
      earned_usd: Math.round(r.totalEarned * 100) / 100,
      since: new Date(r.createdAt * 1000).toISOString(),
    })),
    recent_earnings: db
      .select()
      .from(schema.referralEarnings)
      .where(eq(schema.referralEarnings.referrerId, agentId))
      .orderBy(desc(schema.referralEarnings.createdAt))
      .limit(20)
      .all()
      .map((e) => ({
        swap_id: e.swapId,
        fee_usd: Math.round(e.feeAmount * 100) / 100,
        commission_usd: Math.round(e.commissionAmount * 100) / 100,
        at: new Date(e.createdAt * 1000).toISOString(),
      })),
  });
});

// POST /withdraw — withdraw referral earnings
referral.post("/withdraw", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json();
  const { address, chain } = body as { address: string; chain?: string };

  if (!address) {
    return c.json({ error: "invalid_request", message: "Provide a withdrawal address" }, 400);
  }

  // Calculate available balance
  const referralsList = db
    .select()
    .from(schema.referrals)
    .where(eq(schema.referrals.referrerId, agentId))
    .all();
  const totalEarned = referralsList.reduce((sum, r) => sum + r.totalEarned, 0);

  const withdrawals = db
    .select()
    .from(schema.referralWithdrawals)
    .where(eq(schema.referralWithdrawals.referrerId, agentId))
    .all();
  const totalWithdrawn = withdrawals
    .filter((w) => w.status === "completed")
    .reduce((sum, w) => sum + w.amount, 0);
  const totalPending = withdrawals
    .filter((w) => w.status === "pending")
    .reduce((sum, w) => sum + w.amount, 0);
  const available = totalEarned - totalWithdrawn - totalPending;

  if (available < 1.0) {
    return c.json({
      error: "insufficient_balance",
      available_usd: Math.round(available * 100) / 100,
      pending_usd: Math.round(totalPending * 100) / 100,
      minimum: 1.0,
      message: "Minimum withdrawal is $1.00",
    }, 400);
  }

  const withdrawalId = `rw_${randomUUID().slice(0, 12)}`;
  db.insert(schema.referralWithdrawals).values({
    id: withdrawalId,
    referrerId: agentId,
    amount: available,
    address,
    chain: chain || "base",
    status: "pending",
  }).run();

  return c.json({
    withdrawal_id: withdrawalId,
    amount_usd: Math.round(available * 100) / 100,
    address,
    chain: chain || "base",
    status: "pending",
    message: "Referral withdrawal queued for processing",
  });
});

export default referral;
