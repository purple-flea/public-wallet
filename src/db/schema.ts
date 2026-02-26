import { sqliteTable, text, real, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  apiKeyHash: text("api_key_hash").unique().notNull(),
  referralCode: text("referral_code").unique().notNull(),
  referredBy: text("referred_by"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  lastActive: integer("last_active"),
}, (table) => [
  index("idx_agents_referral").on(table.referralCode),
]);

export const swaps = sqliteTable("swaps", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  orderId: text("order_id").notNull(),
  fromChain: text("from_chain").notNull(),
  toChain: text("to_chain").notNull(),
  fromToken: text("from_token").notNull(),
  toToken: text("to_token").notNull(),
  fromAmount: text("from_amount").notNull(),
  toAddress: text("to_address").notNull(),
  feeAmount: real("fee_amount").notNull(),
  referralPayout: real("referral_payout").default(0).notNull(),
  status: text("status").default("pending").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_swaps_agent").on(table.agentId),
  index("idx_swaps_order").on(table.orderId),
]);

export const referrals = sqliteTable("referrals", {
  referrerId: text("referrer_id").notNull().references(() => agents.id),
  referredId: text("referred_id").notNull().references(() => agents.id),
  commissionRate: real("commission_rate").default(0.10).notNull(),
  totalEarned: real("total_earned").default(0).notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  primaryKey({ columns: [table.referrerId, table.referredId] }),
]);

export const referralEarnings = sqliteTable("referral_earnings", {
  id: text("id").primaryKey(),
  referrerId: text("referrer_id").notNull().references(() => agents.id),
  referredId: text("referred_id").notNull().references(() => agents.id),
  swapId: text("swap_id").notNull().references(() => swaps.id),
  feeAmount: real("fee_amount").notNull(),
  commissionAmount: real("commission_amount").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_ref_earnings_referrer").on(table.referrerId),
]);

export const referralWithdrawals = sqliteTable("referral_withdrawals", {
  id: text("id").primaryKey(),
  referrerId: text("referrer_id").notNull().references(() => agents.id),
  amount: real("amount").notNull(),
  address: text("address").notNull(),
  chain: text("chain").notNull(),
  status: text("status").default("pending").notNull(),
  txHash: text("tx_hash"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});

export const addressBook = sqliteTable("address_book", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  label: text("label").notNull(), // e.g. "My Coinbase", "Trading wallet"
  address: text("address").notNull(),
  chain: text("chain").notNull(), // ethereum, base, solana, bitcoin, tron
  note: text("note"),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_address_book_agent").on(table.agentId),
]);

export const priceAlerts = sqliteTable("price_alerts", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  coin: text("coin").notNull(),               // e.g. "bitcoin", "ethereum", "solana"
  condition: text("condition").notNull(),     // "above" | "below"
  targetPrice: real("target_price").notNull(),
  status: text("status").default("active").notNull(), // active | triggered | deleted
  triggeredAt: integer("triggered_at"),
  triggeredPrice: real("triggered_price"),
  note: text("note"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_price_alerts_agent").on(table.agentId),
  index("idx_price_alerts_status").on(table.status),
]);

export const treasuryLedger = sqliteTable("treasury_ledger", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  amount: real("amount").notNull(),
  source: text("source").notNull(),
  reference: text("reference"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_treasury_created").on(table.createdAt),
]);

// Wallet key storage — stores XMR keys per agent (view key plaintext, spend key AES-encrypted)
export const wallets = sqliteTable("wallets", {
  agentId: text("agent_id").primaryKey().references(() => agents.id),
  xmrAddress: text("xmr_address"),
  xmrViewKey: text("xmr_view_key"),
  xmrSpendKeyEncrypted: text("xmr_spend_key_encrypted"), // AES-256-GCM encrypted hex string
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});
