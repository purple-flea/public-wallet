import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { runMigrations } from "./db/index.js";
import { auth } from "./routes/auth.js";
import wallet from "./routes/wallet.js";
import swap from "./routes/swap.js";
import chains from "./routes/chains.js";
import referral from "./routes/referral.js";

runMigrations();

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok", service: "public-wallet", version: "1.0.0" }));

app.get("/", (c) => c.json({
  service: "Purple Flea Public Wallet",
  version: "1.0.0",
  description: "Multi-chain wallet API for AI agents. Non-custodial HD wallets, on-chain balances, send, and cross-chain swaps.",
  docs: "GET /v1/docs",
}));

const v1 = new Hono();
v1.route("/auth", auth);
v1.route("/wallet", wallet);
v1.route("/wallet/swap", swap);
v1.route("/wallet/chains", chains);
v1.route("/referral", referral);

v1.get("/docs", (c) => c.json({
  auth: {
    "POST /v1/auth/register": "Create agent account + API key. Body: { referral_code? }",
  },
  wallet: {
    "POST /v1/wallet/create": "Generate HD wallet (BIP-39). Returns mnemonic ONCE, derives addresses for Base, Ethereum, Solana, Bitcoin.",
    "GET /v1/wallet/balance/:address?chain=base": "On-chain balance for any address. Chains: base, ethereum, solana.",
    "POST /v1/wallet/send": "Sign + broadcast transaction. Body: { chain, to, amount, private_key, token? }",
  },
  swap: {
    "GET /v1/wallet/swap/quote?from_chain=&to_chain=&from_token=&to_token=&amount=": "Get swap quote with fee breakdown",
    "POST /v1/wallet/swap": "Execute cross-chain swap via Wagyu. Body: { from_chain, to_chain, from_token, to_token, amount, to_address }",
    "GET /v1/wallet/swap/status/:orderId": "Check swap order status",
  },
  chains: {
    "GET /v1/wallet/chains": "List supported chains for wallet and swap operations",
  },
  referral: {
    "GET /v1/referral/code": "Get your referral code",
    "GET /v1/referral/stats": "Referral earnings overview",
    "POST /v1/referral/withdraw": "Withdraw referral earnings. Body: { address, chain? }",
  },
  revenue: "0.5% integrator fee on every swap via Wagyu. 10% of swap fees go to referrer.",
  non_custodial: "Mnemonics and private keys are NEVER stored. Agents manage their own keys.",
}));

app.route("/v1", v1);

const port = parseInt(process.env.PORT || "3006", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Public Wallet v1 running on http://localhost:${info.port}`);
});

export default app;
