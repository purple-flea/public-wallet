/**
 * XMR (Monero) wallet operations using monero-ts (WASM library)
 *
 * Balance checking: createWalletFull with view key, sync from recent height
 * Sending: createWalletFull with spend key + view key, sync, createTx + relayTx
 *
 * Remote daemon: https://xmr-node.cakewallet.com:18081 (mainnet)
 *
 * IMPORTANT: Do NOT call moneroTs.shutdown() — it tears down the WASM thread pool
 * permanently, causing all subsequent createWalletFull() calls to fail with an
 * empty response. Only wallet.close(false) is needed to release individual wallets.
 */

// @ts-ignore – monero-ts is CJS, works fine as ESM named import
import * as moneroTs from "monero-ts";

const DAEMON_URLS = [
  "https://xmr-node.cakewallet.com:18081",
  "https://node.sethforprivacy.com:18089",
  "http://node.moneroworld.com:18089",
];
let activeDaemonUrl = DAEMON_URLS[0];

// In-memory balance cache: address → { balance_xmr, cached_at_ms }
// Bounded to MAX_CACHE_SIZE entries. When full, evict oldest entry (insertion-order LRU).
const balanceCache = new Map<string, { balance_xmr: string; cached_at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 500; // prevent unbounded growth

// Concurrency lock: monero-ts WASM is not safe for simultaneous createWalletFull calls
let xmrLocked = false;
const xmrQueue: Array<() => void> = [];

function acquireXmrLock(): Promise<void> {
  return new Promise((resolve) => {
    if (!xmrLocked) {
      xmrLocked = true;
      resolve();
    } else {
      xmrQueue.push(resolve);
    }
  });
}

function releaseXmrLock(): void {
  const next = xmrQueue.shift();
  if (next) {
    next();
  } else {
    xmrLocked = false;
  }
}

/** Get current daemon height to use as restoreHeight (back-off 15 blocks for safety).
 *  Tries fallback nodes if primary is unreachable. */
async function getDaemonHeight(): Promise<{ height: number; daemonUrl: string }> {
  for (const url of DAEMON_URLS) {
    try {
      const res = await fetch(`${url}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { result?: { height: number } };
      if (data.result?.height) {
        activeDaemonUrl = url;
        return { height: Math.max(0, data.result.height - 15), daemonUrl: url };
      }
    } catch (_) {
      // Try next node
    }
  }
  // All nodes failed — return a safe recent height and use primary URL
  return { height: 3300000, daemonUrl: DAEMON_URLS[0] };
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
 * Serialised via acquireXmrLock() — monero-ts WASM is not safe for concurrent
 * createWalletFull() calls. Queued requests will wait their turn.
 *
 * Throws on error. Returns cached value if available (5-min TTL).
 */
export async function getXmrBalance(
  primaryAddress: string,
  privateViewKey: string
): Promise<XmrBalance> {
  // Check cache first (no lock needed)
  const cached = balanceCache.get(primaryAddress);
  if (cached && Date.now() - cached.cached_at < CACHE_TTL_MS) {
    return {
      balance_xmr: cached.balance_xmr,
      balance_piconero: String(BigInt(Math.round(parseFloat(cached.balance_xmr) * 1e12))),
      cached: true,
      synced_at: new Date(cached.cached_at).toISOString(),
    };
  }

  await acquireXmrLock();
  let wallet: any = null;
  try {
    const { height: restoreHeight, daemonUrl } = await getDaemonHeight();

    wallet = await (moneroTs as any).createWalletFull({
      networkType: "mainnet",
      primaryAddress,
      privateViewKey,
      restoreHeight,
      proxyToWorker: true,
      server: daemonUrl,
    });

    await wallet.sync();
    const balance: bigint = await wallet.getBalance();
    const xmr = (Number(balance) / 1e12).toFixed(12);

    // Evict oldest entry if cache is at capacity (Map preserves insertion order)
    if (balanceCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = balanceCache.keys().next().value;
      if (oldestKey !== undefined) balanceCache.delete(oldestKey);
    }
    balanceCache.set(primaryAddress, { balance_xmr: xmr, cached_at: Date.now() });

    return {
      balance_xmr: xmr,
      balance_piconero: balance.toString(),
      cached: false,
      synced_at: new Date().toISOString(),
    };
  } finally {
    if (wallet) { try { await wallet.close(false); } catch (_) {} }
    // NOTE: Do NOT call moneroTs.shutdown() — it permanently destroys the WASM
    // thread pool, breaking all subsequent XMR operations until process restart.
    releaseXmrLock();
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
 * Serialised via acquireXmrLock().
 */
export async function sendXmr(
  primaryAddress: string,
  privateViewKey: string,
  privateSpendKey: string,
  toAddress: string,
  amountXmr: string
): Promise<XmrSendResult> {
  const amountPiconero = BigInt(Math.round(parseFloat(amountXmr) * 1e12));

  await acquireXmrLock();
  let wallet: any = null;
  try {
    const { height: restoreHeight, daemonUrl } = await getDaemonHeight();

    wallet = await (moneroTs as any).createWalletFull({
      networkType: "mainnet",
      primaryAddress,
      privateViewKey,
      privateSpendKey,
      restoreHeight,
      proxyToWorker: true,
      server: daemonUrl,
    });

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
    if (wallet) { try { await wallet.close(false); } catch (_) {} }
    // NOTE: Do NOT call moneroTs.shutdown() here.
    releaseXmrLock();
  }
}
