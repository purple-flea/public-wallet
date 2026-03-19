import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "fs";
import * as schema from "./schema.js";

mkdirSync("data", { recursive: true });
export const sqlite: import("better-sqlite3").Database = new Database("data/public-wallet.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 30000");

export const db = drizzle(sqlite, { schema });
export { schema };

const migrations = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, api_key_hash TEXT UNIQUE NOT NULL,
  referral_code TEXT UNIQUE NOT NULL, referred_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_active INTEGER
);
CREATE TABLE IF NOT EXISTS swaps (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  order_id TEXT NOT NULL, from_chain TEXT NOT NULL, to_chain TEXT NOT NULL,
  from_token TEXT NOT NULL, to_token TEXT NOT NULL, from_amount TEXT NOT NULL,
  to_address TEXT NOT NULL, fee_amount REAL NOT NULL DEFAULT 0,
  referral_payout REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS referrals (
  referrer_id TEXT NOT NULL REFERENCES agents(id),
  referred_id TEXT NOT NULL REFERENCES agents(id),
  commission_rate REAL NOT NULL DEFAULT 0.10,
  total_earned REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (referrer_id, referred_id)
);
CREATE TABLE IF NOT EXISTS referral_earnings (
  id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL REFERENCES agents(id),
  referred_id TEXT NOT NULL REFERENCES agents(id),
  swap_id TEXT NOT NULL REFERENCES swaps(id),
  fee_amount REAL NOT NULL, commission_amount REAL NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS referral_withdrawals (
  id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL REFERENCES agents(id),
  amount REAL NOT NULL, address TEXT NOT NULL, chain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS treasury_ledger (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL,
  source TEXT NOT NULL, reference TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS address_book (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  label TEXT NOT NULL, address TEXT NOT NULL, chain TEXT NOT NULL,
  note TEXT, last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_address_book_agent ON address_book(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_referral ON agents(referral_code);
CREATE INDEX IF NOT EXISTS idx_swaps_agent ON swaps(agent_id);
CREATE INDEX IF NOT EXISTS idx_swaps_order ON swaps(order_id);
CREATE INDEX IF NOT EXISTS idx_ref_earnings_referrer ON referral_earnings(referrer_id);
CREATE INDEX IF NOT EXISTS idx_treasury_created ON treasury_ledger(created_at);
CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  coin TEXT NOT NULL, condition TEXT NOT NULL,
  target_price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  triggered_at INTEGER, triggered_price REAL,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_agent ON price_alerts(agent_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_status ON price_alerts(status);
CREATE TABLE IF NOT EXISTS wallets (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  xmr_address TEXT,
  xmr_view_key TEXT,
  xmr_spend_key_encrypted TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;


export function runMigrations() {
  sqlite.exec(migrations);
  // v2: add encrypted key columns to wallets — each wrapped to ignore "duplicate column" errors
  const v2Columns = [
    "ALTER TABLE wallets ADD COLUMN eth_private_key TEXT",
    "ALTER TABLE wallets ADD COLUMN sol_private_key TEXT",
    "ALTER TABLE wallets ADD COLUMN btc_private_key TEXT",
    "ALTER TABLE wallets ADD COLUMN tron_private_key TEXT",
    "ALTER TABLE wallets ADD COLUMN mnemonic_encrypted TEXT",
  ];
  for (const stmt of v2Columns) {
    try { sqlite.exec(stmt); } catch (e: any) { if (!e.message?.includes("duplicate column") && !e.message?.includes("already exists")) throw e; }
  }
}
