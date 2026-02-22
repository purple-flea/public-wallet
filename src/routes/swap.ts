import { Hono } from "hono";
import { randomUUID } from "crypto";
import { authMiddleware } from "../middleware/auth.js";
import { getQuote, createOrder, getOrderStatus, calculateFee, INTEGRATOR_FEE_BPS } from "../swap/wagyu.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../types.js";

const TREASURY = process.env.TREASURY_ADDRESS || "0x632881b5f5384e872d8b701dd23f08e63a52faee";

const swap = new Hono<AppEnv>();
swap.use("/*", authMiddleware);

// GET /quote — get swap quote with our fee breakdown
swap.get("/quote", async (c) => {
  const { from_chain, to_chain, from_token, to_token, amount } = c.req.query();

  if (!from_chain || !to_chain || !from_token || !to_token || !amount) {
    return c.json({
      error: "invalid_request",
      message: "Provide from_chain, to_chain, from_token, to_token, amount as query params",
      example: "/v1/wallet/swap/quote?from_chain=base&to_chain=ethereum&from_token=ETH&to_token=USDC&amount=1000000000000000000",
    }, 400);
  }

  try {
    const quote = await getQuote(from_chain, to_chain, from_token, to_token, amount);
    const fromUsd = parseFloat(quote.fromAmountUsd || "0");
    const feeBreakdown = calculateFee(fromUsd);

    return c.json({
      quote,
      integrator_fee: {
        rate: `${INTEGRATOR_FEE_BPS / 100}%`,
        estimated_fee_usd: Math.round(feeBreakdown.fee * 100) / 100,
        note: "Fee is included in the Wagyu quote via integrator program",
      },
      next_step: "POST /v1/wallet/swap with same parameters + to_address",
    });
  } catch (err: any) {
    return c.json({ error: "quote_failed", message: err.message }, 400);
  }
});

// POST / — execute swap via Wagyu
swap.post("/", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json();
  const { from_chain, to_chain, from_token, to_token, amount, to_address } = body as {
    from_chain: string; to_chain: string; from_token: string; to_token: string;
    amount: string; to_address: string;
  };

  if (!from_chain || !to_chain || !from_token || !to_token || !amount || !to_address) {
    return c.json({
      error: "invalid_request",
      message: "Provide from_chain, to_chain, from_token, to_token, amount, to_address",
    }, 400);
  }

  try {
    // Get quote first to calculate fee
    const quote = await getQuote(from_chain, to_chain, from_token, to_token, amount);
    const fromUsd = parseFloat(quote.fromAmountUsd || "0");
    const feeBreakdown = calculateFee(fromUsd);

    // Create swap order on Wagyu
    const order = await createOrder(from_chain, to_chain, from_token, to_token, amount, to_address);

    const swapId = `swap_${randomUUID().slice(0, 12)}`;

    // Check if agent has a referrer
    let referralPayout = 0;
    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    let referrerId: string | null = null;

    if (agent?.referredBy) {
      referrerId = agent.referredBy;
      referralPayout = feeBreakdown.referralShare;

      // Record referral earning
      db.insert(schema.referralEarnings).values({
        id: `re_${randomUUID().slice(0, 12)}`,
        referrerId,
        referredId: agentId,
        swapId,
        feeAmount: feeBreakdown.fee,
        commissionAmount: referralPayout,
      }).run();

      // Update referral total
      db.update(schema.referrals)
        .set({
          totalEarned: db.select().from(schema.referrals)
            .where(eq(schema.referrals.referrerId, referrerId!))
            .get()?.totalEarned! + referralPayout,
        })
        .where(eq(schema.referrals.referrerId, referrerId!))
        .run();
    }

    // Record swap
    db.insert(schema.swaps).values({
      id: swapId,
      agentId,
      orderId: order.orderId,
      fromChain: from_chain,
      toChain: to_chain,
      fromToken: from_token,
      toToken: to_token,
      fromAmount: amount,
      toAddress: to_address,
      feeAmount: feeBreakdown.fee,
      referralPayout,
      status: order.status,
    }).run();

    // Record revenue in treasury ledger
    db.insert(schema.treasuryLedger).values({
      id: `rev_${randomUUID().slice(0, 12)}`,
      type: "revenue",
      amount: feeBreakdown.netRevenue,
      source: "integrator_fee",
      reference: order.orderId,
    }).run();

    return c.json({
      swap_id: swapId,
      order_id: order.orderId,
      status: order.status,
      deposit: {
        address: order.depositAddress,
        chain: order.depositChain,
        token: order.depositTokenSymbol,
        amount: order.depositAmount,
        instruction: `Send exactly ${order.depositAmount} ${order.depositTokenSymbol} to ${order.depositAddress} on ${order.depositChain}`,
      },
      output: {
        address: order.toAddress,
        expected_amount: order.expectedOutput,
      },
      fee: {
        rate: `${INTEGRATOR_FEE_BPS / 100}%`,
        amount_usd: Math.round(feeBreakdown.fee * 100) / 100,
        treasury: TREASURY,
      },
      expires_at: order.expiresAt,
      check_status: `GET /v1/wallet/swap/status/${order.orderId}`,
    });
  } catch (err: any) {
    return c.json({ error: "swap_failed", message: err.message }, 400);
  }
});

// GET /status/:orderId — check swap status on Wagyu
swap.get("/status/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  try {
    const status = await getOrderStatus(orderId);
    return c.json(status);
  } catch (err: any) {
    return c.json({ error: "status_check_failed", message: err.message }, 400);
  }
});

export default swap;
