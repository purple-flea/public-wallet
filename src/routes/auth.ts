import { Hono } from "hono";
import { randomBytes } from "crypto";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const auth = new Hono<AppEnv>();

// POST /register — create agent account + API key
auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `pk_live_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);
  const myReferralCode = `ref_${randomBytes(4).toString("hex")}`;

  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents).where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer) referrerId = referrer.id;
  }

  db.insert(schema.agents).values({
    id: agentId,
    apiKeyHash: keyHash,
    referralCode: myReferralCode,
    referredBy: referrerId,
  }).run();

  if (referrerId) {
    db.insert(schema.referrals).values({
      referrerId,
      referredId: agentId,
      commissionRate: 0.10,
    }).run();
  }

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    referral_code: myReferralCode,
    message: "Store your API key securely — it cannot be recovered.",
    next_steps: [
      "POST /v1/wallet/create — generate an HD wallet",
      "GET /v1/wallet/balance/:address?chain=base — check on-chain balance",
      "POST /v1/wallet/send — sign and broadcast a transaction",
      "POST /v1/wallet/swap — cross-chain swap via Wagyu",
      "GET /v1/wallet/chains — see supported chains",
    ],
  }, 201);
});

export { auth };
