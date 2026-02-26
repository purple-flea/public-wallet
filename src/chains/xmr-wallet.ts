/**
 * XMR (Monero) wallet operations using monero-ts (WASM library)
 *
 * Balance checking: createWalletFull with view key, sync from recent height
 * Sending: createWalletFull with spend key + view key, sync, createTx + relayTx
 *
 * Remote daemon: https://xmr-node.cakewallet.com:18081 (mainnet)
 */

// @ts-ignore – monero-ts is CJS, works fine as ESM named import
import * as moneroTs from "monero-ts";

const DAEMON_URL = "https://xmr-node.cakewallet.com:18081";
const PICONERO_PER_XMR = 1_000_000_000_000n; // 1e12

// In-memory balance cache: address → { balance_xmr, cached_at_ms }
const balanceCache = new Map<string, { balance_xmr: string; cached_at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Get current daemon height to use as restoreHeight (back-off 15 blocks for safety) */
async function getDaemonHeight(): Promise<number> {
  const res = await fetch(`${DAEMON_URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
  });
  const data = (await res.json()) as { result: { height: number } };
  return Math.max(0, data.result.height - 15);
}

export interface XmrBalance {
  balance_xmr: string;
  balance_piconero: string;
  cached: boolean;
  synced_at: string;
}

/**
 * Check XMR balance for a view-only wallet.
 * Uses monero-ts WASM to create a wallet with the view key, sync from a recent
 * daemon height, and return the balance.
 *
 * Throws on error. Returns a stale cached value if available.
 */
export async function getXmrBalance(
  primaryAddress: string,
  privateViewKey: string
): Promise<XmrBalance> {
  // Check cache first
  const cached = balanceCache.get(primaryAddress);
  if (cached && Date.now() - cached.cached_at < CACHE_TTL_MS) {
    return {
      balance_xmr: cached.balance_xmr,
      balance_piconero: String(BigInt(Math.round(parseFloat(cached.balance_xmr) * 1e12))),
      cached: true,
      synced_at: new Date(cached.cached_at).toISOString(),
    };
  }

  const restoreHeight = await getDaemonHeight();

  const wallet = await (moneroTs as any).createWalletFull({
    networkType: "mainnet",
    primaryAddress,
    privateViewKey,
    restoreHeight,
    proxyToWorker: true,
    server: DAEMON_URL,
  });

  try {
    await wallet.sync();
    const balance: bigint = await wallet.getBalance();
    const xmr = (Number(balance) / 1e12).toFixed(12);

    balanceCache.set(primaryAddress, { balance_xmr: xmr, cached_at: Date.now() });

    return {
      balance_xmr: xmr,
      balance_piconero: balance.toString(),
      cached: false,
      synced_at: new Date().toISOString(),
    };
  } finally {
    try { await wallet.close(false); } catch (_) {}
    try { await (moneroTs as any).shutdown(); } catch (_) {}
  }
}

export interface XmrSendResult {
  tx_hash: string;
  fee_xmr: string;
  amount_xmr: string;
}

/**
 * Send XMR from a full wallet (requires spend key).
 * Creates a wallet with spend key + view key, syncs, creates + relays the tx.
 */
export async function sendXmr(
  primaryAddress: string,
  privateViewKey: string,
  privateSpendKey: string,
  toAddress: string,
  amountXmr: string
): Promise<XmrSendResult> {
  const restoreHeight = await getDaemonHeight();
  const amountPiconero = BigInt(Math.round(parseFloat(amountXmr) * 1e12));

  const wallet = await (moneroTs as any).createWalletFull({
    networkType: "mainnet",
    primaryAddress,
    privateViewKey,
    privateSpendKey,
    restoreHeight,
    proxyToWorker: true,
    server: DAEMON_URL,
  });

  try {
    await wallet.sync();

    const tx = await wallet.createTx({
      address: toAddress,
      amount: amountPiconero,
      relay: true,
    });

    const txHash: string = tx.getHash();
    const fee: bigint = tx.getFee() ?? 0n;
    const amount: bigint = tx.getOutgoingTransfer()?.getAmount() ?? amountPiconero;

    // Invalidate cache for this address
    balanceCache.delete(primaryAddress);

    return {
      tx_hash: txHash,
      fee_xmr: (Number(fee) / 1e12).toFixed(12),
      amount_xmr: (Number(amount) / 1e12).toFixed(12),
    };
  } finally {
    try { await wallet.close(false); } catch (_) {}
    try { await (moneroTs as any).shutdown(); } catch (_) {}
  }
}
