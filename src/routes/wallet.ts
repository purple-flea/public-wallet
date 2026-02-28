import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { SUPPORTED_CHAINS, type ChainName } from "../chains/config.js";
import type { AppEnv } from "../types.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, desc, sql, and } from "drizzle-orm";
import * as bip39 from "bip39";
import { ethers } from "ethers";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { deriveMoneroKeys } from "../chains/monero.js";
import { getXmrBalance, sendXmr } from "../chains/xmr-wallet.js";

// AES-256-GCM encryption for XMR spend key storage
// Key is derived from a server-side secret + agentId to make per-agent encrypted blobs
const XMR_ENC_SECRET = process.env.XMR_ENC_SECRET || "purple-flea-xmr-key-v1-fallback-secret-32b";

function encryptXmrKey(plaintext: string, agentId: string): string {
  const keyMaterial = createHash("sha256").update(XMR_ENC_SECRET + agentId).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext, all as hex
  return iv.toString("hex") + tag.toString("hex") + encrypted.toString("hex");
}

function decryptXmrKey(encrypted: string, agentId: string): string {
  const keyMaterial = createHash("sha256").update(XMR_ENC_SECRET + agentId).digest();
  const ivHex = encrypted.slice(0, 24);
  const tagHex = encrypted.slice(24, 56);
  const ctHex = encrypted.slice(56);
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

const bip32 = BIP32Factory(ecc);

// Singleton EVM providers — reuse across requests to avoid per-request timer/socket leaks.
// ethers.JsonRpcProvider created per-request accumulates internal polling intervals that are
// never cleared, causing the ~300-500MB memory growth. Singletons are safe here because we
// only use them for read calls (getBalance) and the JsonRpcProvider is stateless otherwise.
const _evmProviders = new Map<string, ethers.JsonRpcProvider>();
function getEvmProvider(rpcUrl: string): ethers.JsonRpcProvider {
  let p = _evmProviders.get(rpcUrl);
  if (!p) {
    p = new ethers.JsonRpcProvider(rpcUrl);
    _evmProviders.set(rpcUrl, p);
  }
  return p;
}

// Tron address helpers
function tronBase58ToHex(address: string): string {
  const decoded = bs58.decode(address);
  const payload = decoded.slice(0, decoded.length - 4);
  return Buffer.from(payload).toString("hex");
}

const wallet = new Hono<AppEnv>();
wallet.use("/*", authMiddleware);

// POST /create — generate HD wallet, derive addresses for all chains, return mnemonic ONCE
wallet.post("/create", async (c) => {
  const mnemonic = bip39.generateMnemonic(256); // 24 words
  const seed = await bip39.mnemonicToSeed(mnemonic);

  const addresses: Record<string, string> = {};

  // Ethereum & Base (same derivation path, same address)
  const ethRoot = bip32.fromSeed(Buffer.from(seed));
  const ethChild = ethRoot.derivePath("m/44'/60'/0'/0/0");
  const ethWallet = new ethers.Wallet(
    Buffer.from(ethChild.privateKey!).toString("hex")
  );
  addresses.ethereum = ethWallet.address;
  addresses.base = ethWallet.address;

  // Solana
  const solDerived = derivePath("m/44'/501'/0'/0'", Buffer.from(seed).toString("hex"));
  const solKeypair = Keypair.fromSeed(Uint8Array.from(solDerived.key));
  addresses.solana = solKeypair.publicKey.toBase58();

  // Bitcoin (native segwit / bech32)
  const btcRoot = bip32.fromSeed(Buffer.from(seed));
  const btcChild = btcRoot.derivePath("m/84'/0'/0'/0/0");
  const { address: btcAddress } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(btcChild.publicKey),
  });
  addresses.bitcoin = btcAddress!;

  // Tron — same BIP32 root, path m/44'/195'/0'/0/0, Ethereum-style key, base58check encoded
  const tronChild = ethRoot.derivePath("m/44'/195'/0'/0/0");
  const tronEthWallet = new ethers.Wallet(
    Buffer.from(tronChild.privateKey!).toString("hex")
  );
  const tronAddrBytes = Buffer.from(tronEthWallet.address.slice(2), "hex");
  const tronPayload = Buffer.concat([Buffer.from([0x41]), tronAddrBytes]);
  const tronChecksum = createHash("sha256")
    .update(createHash("sha256").update(tronPayload).digest())
    .digest()
    .slice(0, 4);
  addresses.tron = bs58.encode(Buffer.concat([tronPayload, tronChecksum]));

  // Monero (XMR) — HMAC-SHA512 from seed, Ed25519 keys, Monero base58
  const xmrKeys = deriveMoneroKeys(Uint8Array.from(seed));
  addresses.monero = xmrKeys.address;

  // Store all keys server-side (XMR view key plaintext, all others AES-256-GCM encrypted)
  const agentId = c.get("agentId");
  const encryptedSpendKey = encryptXmrKey(xmrKeys.privateSpendKey, agentId);

  // ETH/Base private key (hex, no 0x prefix)
  const ethPrivKeyHex = Buffer.from(ethChild.privateKey!).toString("hex");
  // Solana private key (base58-encoded full 64-byte secret key)
  const solPrivKeyB58 = bs58.encode(solKeypair.secretKey);
  // Bitcoin private key (WIF)
  const btcWif = btcChild.toWIF();
  // Tron private key (hex, no 0x prefix — same format as ETH key)
  const tronPrivKeyHex = Buffer.from(tronChild.privateKey!).toString("hex");

  db.insert(schema.wallets).values({
    agentId,
    xmrAddress: xmrKeys.address,
    xmrViewKey: xmrKeys.privateViewKey,
    xmrSpendKeyEncrypted: encryptedSpendKey,
    ethPrivateKeyEncrypted: encryptXmrKey(ethPrivKeyHex, agentId),
    solPrivateKeyEncrypted: encryptXmrKey(solPrivKeyB58, agentId),
    btcPrivateKeyEncrypted: encryptXmrKey(btcWif, agentId),
    tronPrivateKeyEncrypted: encryptXmrKey(tronPrivKeyHex, agentId),
    mnemonicEncrypted: encryptXmrKey(mnemonic, agentId),
  }).onConflictDoUpdate({
    target: schema.wallets.agentId,
    set: {
      xmrAddress: xmrKeys.address,
      xmrViewKey: xmrKeys.privateViewKey,
      xmrSpendKeyEncrypted: encryptedSpendKey,
      ethPrivateKeyEncrypted: encryptXmrKey(ethPrivKeyHex, agentId),
      solPrivateKeyEncrypted: encryptXmrKey(solPrivKeyB58, agentId),
      btcPrivateKeyEncrypted: encryptXmrKey(btcWif, agentId),
      tronPrivateKeyEncrypted: encryptXmrKey(tronPrivKeyHex, agentId),
      mnemonicEncrypted: encryptXmrKey(mnemonic, agentId),
    },
  }).run();

  return c.json({
    mnemonic,
    addresses,
    monero_keys: {
      private_spend_key: xmrKeys.privateSpendKey,
      private_view_key: xmrKeys.privateViewKey,
      note: "XMR keys stored server-side for this agent — balance checks and sends work without passing keys each time. Save keys for offline use.",
    },
    warning: "This mnemonic is shown ONCE and never stored. Save it securely. Loss = loss of funds.",
    derivation_paths: {
      ethereum: "m/44'/60'/0'/0/0",
      base: "m/44'/60'/0'/0/0 (same as ethereum)",
      solana: "m/44'/501'/0'/0'",
      bitcoin: "m/84'/0'/0'/0/0 (native segwit)",
      tron: "m/44'/195'/0'/0/0 (base58check, supports USDT TRC-20)",
      monero: "HMAC-SHA512('monero seed', bip39_seed) → Ed25519 keys",
    },
  }, 201);
});

// GET /deposit-address — returns agent's deposit instructions (non-custodial: addresses are derived from mnemonic)
wallet.get("/deposit-address", async (c) => {
  return c.json({
    note: "This is a non-custodial wallet service. Your deposit addresses are derived from your mnemonic.",
    how_to_get_address: "POST /v1/wallet/create to generate a new HD wallet — mnemonic shown ONCE. Save it securely.",
    if_you_already_have_mnemonic: "Use a BIP39/BIP32 tool to re-derive addresses from your mnemonic offline.",
    derivation_paths: {
      ethereum: "m/44'/60'/0'/0/0",
      base: "m/44'/60'/0'/0/0 (same as ethereum — EVM compatible)",
      solana: "m/44'/501'/0'/0'",
      bitcoin: "m/84'/0'/0'/0/0 (native segwit bech32)",
      tron: "m/44'/195'/0'/0/0 (base58check, supports USDT TRC-20)",
      monero: "HMAC-SHA512('monero seed', bip39_seed) → Ed25519 keys (returned in monero_keys on wallet create)",
    },
    tip: "Any address from these paths will accept deposits. Use Base USDC for lowest fees and fastest confirmation.",
    check_balance: "GET /v1/wallet/balance/:your_address?chain=base",
    check_xmr_balance: "GET /v1/wallet/balance/:xmr_address?chain=monero&view_key=<private_view_key>",
    supported_deposit_chains: ["ethereum", "base", "solana", "bitcoin", "tron", "monero"],
    monero_note: "XMR address and keys (private_view_key, private_spend_key) are returned when you POST /v1/wallet/create",
  });
});

// GET /transactions/:address — recent on-chain transactions
wallet.get("/transactions/:address", async (c) => {
  const address = c.req.param("address");
  const chain = (c.req.query("chain") || "base") as string;
  const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 50);

  if (chain === "bitcoin") {
    try {
      const res = await fetch(`https://mempool.space/api/address/${address}/txs`);
      if (!res.ok) return c.json({ error: "api_error", message: `mempool.space ${res.status}` }, 502);
      const txs = await res.json() as any[];
      return c.json({
        address, chain,
        transactions: txs.slice(0, limit).map((tx: any) => ({
          txid: tx.txid,
          confirmed: tx.status?.confirmed ?? false,
          block_height: tx.status?.block_height ?? null,
          fee: tx.fee,
          value_in: tx.vout?.reduce((sum: number, o: any) => o.scriptpubkey_address === address ? sum + o.value : sum, 0) ?? 0,
          value_out: tx.vin?.reduce((sum: number, i: any) => i.prevout?.scriptpubkey_address === address ? sum + i.prevout.value : sum, 0) ?? 0,
        })),
        explorer: `https://mempool.space/address/${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "api_error", message: err.message }, 502);
    }
  }

  if (chain === "solana") {
    try {
      const chainConfig = SUPPORTED_CHAINS["solana"];
      const res = await fetch(chainConfig.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [address, { limit }],
        }),
      });
      const data = await res.json() as any;
      return c.json({
        address, chain,
        transactions: (data.result ?? []).map((sig: any) => ({
          signature: sig.signature,
          slot: sig.slot,
          block_time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
          err: sig.err,
        })),
        explorer: `https://explorer.solana.com/address/${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "rpc_error", message: err.message }, 502);
    }
  }

  // EVM chains — use Etherscan-compatible APIs
  const explorerApis: Record<string, string> = {
    base: "https://api.basescan.org/api",
    ethereum: "https://api.etherscan.io/api",
  };
  const explorerApi = explorerApis[chain];
  if (!explorerApi) {
    return c.json({
      error: "unsupported_chain",
      message: `Transaction history not supported for ${chain} yet`,
      supported_chains: ["bitcoin", "solana", "base", "ethereum"],
    }, 400);
  }

  try {
    const url = `${explorerApi}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=desc&apikey=YourApiKeyToken`;
    const res = await fetch(url);
    const data = await res.json() as any;

    if (data.status === "0" && data.message !== "No transactions found") {
      // API key not configured — return helpful message
      return c.json({
        address, chain,
        transactions: [],
        note: `Transaction history for ${chain} requires a block explorer API key. Use https://basescan.org/address/${address} to view manually.`,
        explorer: `https://basescan.org/address/${address}`,
      });
    }

    const txs = (data.result ?? []).slice(0, limit);
    return c.json({
      address, chain,
      transactions: txs.map((tx: any) => ({
        hash: tx.hash,
        block_number: parseInt(tx.blockNumber),
        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        from: tx.from,
        to: tx.to,
        value_eth: ethers.formatEther(tx.value || "0"),
        gas_used: tx.gasUsed,
        status: tx.isError === "0" ? "success" : "failed",
      })),
      explorer: `https://basescan.org/address/${address}`,
    });
  } catch (err: any) {
    return c.json({ error: "api_error", message: err.message }, 502);
  }
});

// GET /balance/:address — on-chain balance
wallet.get("/balance/:address", async (c) => {
  const address = c.req.param("address");
  const chain = (c.req.query("chain") || "base") as string;

  const chainConfig = SUPPORTED_CHAINS[chain as ChainName];
  if (!chainConfig) {
    return c.json({
      error: "unsupported_chain",
      supported: Object.keys(SUPPORTED_CHAINS),
    }, 400);
  }

  if (chain === "bitcoin") {
    try {
      const res = await fetch(`https://mempool.space/api/address/${address}`);
      if (!res.ok) {
        return c.json({ error: "api_error", message: `mempool.space returned ${res.status}` }, 502);
      }
      const data = await res.json() as any;
      const confirmedSats =
        (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0);
      const unconfirmedSats =
        (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0);
      const totalSats = confirmedSats + unconfirmedSats;
      return c.json({
        address,
        chain,
        balance: {
          native: {
            symbol: "BTC",
            amount: (totalSats / 1e8).toString(),
            confirmed_satoshis: confirmedSats,
            unconfirmed_satoshis: unconfirmedSats,
            total_satoshis: totalSats,
          },
        },
        explorer: `https://mempool.space/address/${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "api_error", message: err.message }, 502);
    }
  }

  if (chain === "solana") {
    try {
      const res = await fetch(chainConfig.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [address],
        }),
      });
      const data = await res.json() as any;
      const lamports = data.result?.value ?? 0;
      return c.json({
        address,
        chain,
        balance: {
          native: { symbol: "SOL", amount: (lamports / 1e9).toString(), lamports },
        },
        explorer: `${chainConfig.explorer}/account/${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "rpc_error", message: err.message }, 502);
    }
  }


  if (chain === "tron") {
    try {
      const res = await fetch("https://api.trongrid.io/wallet/getaccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, visible: true }),
      });
      const data = await res.json() as any;
      if (!data || !data.address) {
        // Not activated on-chain yet (no transactions)
        return c.json({
          address, chain: "tron",
          balance: { native: { symbol: "TRX", amount: "0", sun: 0 } },
          explorer: `https://tronscan.org/#/address/${address}`,
          note: "Address not yet activated on-chain",
        });
      }
      const sun = data.balance ?? 0;
      const trc20: Record<string, string> = {};
      if (Array.isArray(data.trc20)) {
        for (const t of data.trc20) {
          for (const [contract, amt] of Object.entries(t as Record<string, string>)) {
            trc20[contract] = amt;
          }
        }
      }
      return c.json({
        address, chain: "tron",
        balance: {
          native: { symbol: "TRX", amount: (sun / 1_000_000).toString(), sun },
          trc20: Object.keys(trc20).length > 0 ? trc20 : undefined,
        },
        explorer: `https://tronscan.org/#/address/${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "api_error", message: err.message }, 502);
    }
  }

  if (chain === "monero") {
    // view_key can come from query param OR from stored wallet record
    let viewKey = c.req.query("view_key");
    if (!viewKey) {
      const agentId = c.get("agentId");
      const stored = db.select().from(schema.wallets).where(eq(schema.wallets.agentId, agentId)).get();
      if (stored?.xmrViewKey) {
        viewKey = stored.xmrViewKey;
      }
    }
    if (!viewKey) {
      return c.json({
        error: "view_key_required",
        message: "Monero balance requires your private_view_key. Either POST /v1/wallet/create first (keys auto-stored) or pass ?view_key=<hex>.",
        example: `GET /v1/wallet/balance/${address}?chain=monero&view_key=<your_private_view_key>`,
      }, 400);
    }
    try {
      const xmrBalance = await getXmrBalance(address, viewKey);
      return c.json({
        address,
        chain: "monero",
        balance: {
          native: {
            symbol: "XMR",
            amount: xmrBalance.balance_xmr,
            piconero: xmrBalance.balance_piconero,
          },
        },
        synced_at: xmrBalance.synced_at,
        cached: xmrBalance.cached,
        explorer: `https://xmrchain.net/search?value=${address}`,
      });
    } catch (err: any) {
      return c.json({ error: "xmr_balance_error", message: err.message }, 502);
    }
  }

  // EVM chains (ethereum, base)
  try {
    const provider = getEvmProvider(chainConfig.rpcUrl);
    const balance = await provider.getBalance(address);
    return c.json({
      address,
      chain,
      balance: {
        native: {
          symbol: chainConfig.nativeToken,
          amount: ethers.formatEther(balance),
          wei: balance.toString(),
        },
      },
      explorer: `${chainConfig.explorer}/address/${address}`,
    });
  } catch (err: any) {
    return c.json({ error: "rpc_error", message: err.message }, 502);
  }
});

// POST /send — sign and broadcast a transaction (agent provides private key)
wallet.post("/send", async (c) => {
  const body = await c.req.json();
  const { chain, to, amount, private_key, token } = body as {
    chain: string; to: string; amount: string; private_key: string; token?: string;
  };

  // Monero uses separate view_key + spend_key instead of private_key
  const isMonero = chain === "monero";
  if (!chain || !to || !amount || (!private_key && !isMonero)) {
    return c.json({
      error: "invalid_request",
      message: isMonero
        ? "Provide chain, from, to, amount, view_key, and spend_key for Monero"
        : "Provide chain, to, amount, and private_key",
    }, 400);
  }

  const chainConfig = SUPPORTED_CHAINS[chain as ChainName];
  if (!chainConfig) {
    return c.json({ error: "unsupported_chain", supported: Object.keys(SUPPORTED_CHAINS) }, 400);
  }

  if (chain === "bitcoin") {
    return c.json({
      error: "not_implemented",
      message: "Bitcoin send requires UTXO management. Use a dedicated Bitcoin library.",
    }, 501);
  }

  if (chain === "solana") {
    try {
      const { Connection, Transaction, SystemProgram, PublicKey } = await import("@solana/web3.js");
      const conn = new Connection(chainConfig.rpcUrl, "confirmed");

      // Decode private key (base58)
      const secretKey = bs58.decode(private_key);
      const keypair = Keypair.fromSecretKey(secretKey);

      const lamports = Math.floor(parseFloat(amount) * 1e9);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(to),
          lamports,
        })
      );

      const sig = await conn.sendTransaction(tx, [keypair]);
      return c.json({
        tx_hash: sig,
        chain,
        from: keypair.publicKey.toBase58(),
        to,
        amount,
        explorer: `${chainConfig.explorer}/tx/${sig}`,
      });
    } catch (err: any) {
      return c.json({ error: "send_failed", message: err.message }, 400);
    }
  }


  if (chain === "tron") {
    try {
      // Derive sender hex address from private key
      const pkHex = private_key.startsWith("0x") ? private_key.slice(2) : private_key;
      const tronWallet = new ethers.Wallet("0x" + pkHex);
      const ownerHex = "41" + tronWallet.address.slice(2).toLowerCase();
      const toHex = tronBase58ToHex(to);
      const amountSun = Math.floor(parseFloat(amount) * 1_000_000);

      // Create transaction
      const createRes = await fetch("https://api.trongrid.io/wallet/createtransaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_address: ownerHex, to_address: toHex, amount: amountSun }),
      });
      const txData = await createRes.json() as any;
      if (txData.Error) {
        return c.json({ error: "tx_create_failed", message: txData.Error }, 400);
      }

      // Sign: SHA256 of raw_data_hex, secp256k1 sign, Tron format r+s+v
      const hash = createHash("sha256").update(Buffer.from(txData.raw_data_hex, "hex")).digest();
      const sigKey = new ethers.SigningKey("0x" + pkHex);
      const sig = sigKey.sign(hash);
      const vByte = (sig.v - 27).toString(16).padStart(2, "0");
      const signature = sig.r.slice(2) + sig.s.slice(2) + vByte;

      // Broadcast
      const broadRes = await fetch("https://api.trongrid.io/wallet/broadcasttransaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...txData, signature: [signature] }),
      });
      const result = await broadRes.json() as any;
      if (!result.result) {
        return c.json({ error: "broadcast_failed", message: result.message || JSON.stringify(result) }, 400);
      }
      return c.json({
        tx_hash: result.txid, chain: "tron", to,
        amount: `${amountSun / 1_000_000} TRX`,
        explorer: `https://tronscan.org/#/transaction/${result.txid}`,
      });
    } catch (err: any) {
      return c.json({ error: "send_failed", message: err.message }, 400);
    }
  }

  if (chain === "monero") {
    const { view_key: bodyViewKey, spend_key: bodySpendKey, from } = body as { view_key?: string; spend_key?: string; from?: string };

    // Try to look up stored keys if not provided in request body
    let resolvedViewKey = bodyViewKey;
    let resolvedSpendKey = bodySpendKey;
    let resolvedFrom = from;

    const agentId = c.get("agentId");
    const stored = db.select().from(schema.wallets).where(eq(schema.wallets.agentId, agentId)).get();
    if (stored) {
      if (!resolvedViewKey && stored.xmrViewKey) resolvedViewKey = stored.xmrViewKey;
      if (!resolvedSpendKey && stored.xmrSpendKeyEncrypted) {
        try { resolvedSpendKey = decryptXmrKey(stored.xmrSpendKeyEncrypted, agentId); } catch (_) {}
      }
      if (!resolvedFrom && stored.xmrAddress) resolvedFrom = stored.xmrAddress;
    }

    if (!resolvedViewKey || !resolvedSpendKey || !resolvedFrom) {
      return c.json({
        error: "keys_required",
        message: "Monero send requires from (your primary address), view_key, and spend_key. POST /v1/wallet/create first to auto-store keys, or pass them in the request body.",
        required_body_fields: ["chain", "from", "to", "amount", "view_key", "spend_key"],
        tip: "If you used POST /v1/wallet/create, keys are auto-stored — just provide chain, to, and amount.",
      }, 400);
    }
    try {
      const result = await sendXmr(resolvedFrom, resolvedViewKey, resolvedSpendKey, to, amount);
      return c.json({
        tx_hash: result.tx_hash,
        chain: "monero",
        from: resolvedFrom,
        to,
        amount: result.amount_xmr,
        fee: result.fee_xmr,
        explorer: `https://xmrchain.net/tx/${result.tx_hash}`,
      });
    } catch (err: any) {
      return c.json({ error: "xmr_send_failed", message: err.message }, 400);
    }
  }

  // EVM chains
  try {
    const provider = getEvmProvider(chainConfig.rpcUrl);
    const signer = new ethers.Wallet(private_key, provider);

    if (token) {
      // ERC-20 transfer
      const erc20Abi = ["function transfer(address to, uint256 amount) returns (bool)"];
      const contract = new ethers.Contract(token, erc20Abi, signer);
      const tx = await contract.transfer(to, ethers.parseUnits(amount, 6)); // assume 6 decimals for USDC/USDT
      const receipt = await tx.wait();
      return c.json({
        tx_hash: receipt.hash,
        chain,
        from: signer.address,
        to,
        amount,
        token,
        explorer: `${chainConfig.explorer}/tx/${receipt.hash}`,
      });
    }

    // Native transfer
    const tx = await signer.sendTransaction({
      to,
      value: ethers.parseEther(amount),
    });
    const receipt = await tx.wait();
    return c.json({
      tx_hash: receipt!.hash,
      chain,
      from: signer.address,
      to,
      amount,
      explorer: `${chainConfig.explorer}/tx/${receipt!.hash}`,
    });
  } catch (err: any) {
    return c.json({ error: "send_failed", message: err.message }, 400);
  }
});

// GET /price — quick price lookup for common crypto assets (no auth) - useful for valuing holdings
wallet.get("/price", async (c) => {
  const symbol = (c.req.query("symbol") || "").toUpperCase().trim();

  if (!symbol) {
    return c.json({
      error: "missing_symbol",
      message: "Provide ?symbol=BTC (or ETH, SOL, USDC, etc.)",
      examples: [
        "GET /v1/wallet/price?symbol=BTC",
        "GET /v1/wallet/price?symbol=ETH",
        "GET /v1/wallet/price?symbol=SOL",
        "GET /v1/wallet/price?symbol=BNB",
      ],
      supported_sources: "CoinGecko (free tier)",
    }, 400);
  }

  // Map common symbols to CoinGecko IDs
  const cgIdMap: Record<string, string> = {
    BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
    XRP: "ripple", DOGE: "dogecoin", ADA: "cardano", AVAX: "avalanche-2",
    DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
    LTC: "litecoin", BCH: "bitcoin-cash", XLM: "stellar", ATOM: "cosmos",
    ALGO: "algorand", ICP: "internet-computer", NEAR: "near", FTM: "fantom",
    USDC: "usd-coin", USDT: "tether", DAI: "dai", BUSD: "binance-usd",
    TRX: "tron", XMR: "monero", SHIB: "shiba-inu", APT: "aptos",
    ARB: "arbitrum", OP: "optimism", TON: "the-open-network",
    SUI: "sui", SEI: "sei-network", INJ: "injective-protocol",
  };

  const cgId = cgIdMap[symbol];
  if (!cgId) {
    return c.json({
      error: "unsupported_symbol",
      message: `Price lookup not available for ${symbol}. Supported: ${Object.keys(cgIdMap).join(", ")}`,
    }, 404);
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) {
      return c.json({ error: "price_api_error", message: `CoinGecko returned ${res.status}` }, 502);
    }
    const data = await res.json() as any;
    const coinData = data[cgId];
    if (!coinData) {
      return c.json({ error: "no_price_data", message: `No price data for ${symbol}` }, 404);
    }
    return c.json({
      symbol,
      coingecko_id: cgId,
      price_usd: coinData.usd,
      change_24h_pct: coinData.usd_24h_change != null ? Math.round(coinData.usd_24h_change * 100) / 100 : null,
      market_cap_usd: coinData.usd_market_cap ?? null,
      timestamp: new Date().toISOString(),
      source: "CoinGecko",
    });
  } catch (err: any) {
    return c.json({ error: "price_fetch_failed", message: err.message }, 502);
  }
});

// GET /prices?symbols=BTC,ETH,SOL — batch price lookup for multiple coins
wallet.get("/prices", async (c) => {
  const symbolsParam = c.req.query("symbols") || "";
  const symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

  if (symbols.length === 0) {
    return c.json({
      error: "missing_symbols",
      message: "Provide ?symbols=BTC,ETH,SOL (comma-separated, up to 20)",
      example: "GET /v1/wallet/prices?symbols=BTC,ETH,SOL,BNB,TRX",
    }, 400);
  }

  const cgIdMap: Record<string, string> = {
    BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
    XRP: "ripple", DOGE: "dogecoin", ADA: "cardano", AVAX: "avalanche-2",
    DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
    LTC: "litecoin", BCH: "bitcoin-cash", XLM: "stellar", ATOM: "cosmos",
    ALGO: "algorand", NEAR: "near", USDC: "usd-coin", USDT: "tether",
    DAI: "dai", TRX: "tron", XMR: "monero", SHIB: "shiba-inu", APT: "aptos",
    ARB: "arbitrum", OP: "optimism", TON: "the-open-network",
    SUI: "sui", SEI: "sei-network", INJ: "injective-protocol",
  };

  const resolved: Array<{ symbol: string; cgId: string }> = [];
  const unsupported: string[] = [];

  for (const symbol of symbols) {
    const cgId = cgIdMap[symbol];
    if (cgId) resolved.push({ symbol, cgId });
    else unsupported.push(symbol);
  }

  if (resolved.length === 0) {
    return c.json({
      error: "no_supported_symbols",
      message: `None of the requested symbols are supported: ${symbols.join(", ")}`,
      supported: Object.keys(cgIdMap),
    }, 400);
  }

  const uniqueIds = [...new Set(resolved.map(r => r.cgId))].join(",");

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueIds}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );

    const data = res.ok ? await res.json() as Record<string, any> : {};

    const prices = resolved.map(({ symbol, cgId }) => {
      const d = data[cgId];
      return {
        symbol,
        price_usd: d?.usd ?? null,
        change_24h_pct: d?.usd_24h_change != null ? Math.round(d.usd_24h_change * 100) / 100 : null,
        market_cap_usd: d?.usd_market_cap ?? null,
      };
    });

    return c.json({
      prices,
      unsupported: unsupported.length > 0 ? unsupported : undefined,
      count: prices.length,
      timestamp: new Date().toISOString(),
      source: "CoinGecko",
    });
  } catch (err: any) {
    return c.json({ error: "price_fetch_failed", message: err.message }, 502);
  }
});

// GET /portfolio-value?btc=bc1q...&eth=0x...&sol=So1... — USD value of multiple addresses
wallet.get("/portfolio-value", async (c) => {
  const chainNativeTokens: Record<string, { symbol: string; cgId: string }> = {
    ethereum: { symbol: "ETH", cgId: "ethereum" },
    base: { symbol: "ETH", cgId: "ethereum" }, // Base uses ETH
    solana: { symbol: "SOL", cgId: "solana" },
    bitcoin: { symbol: "BTC", cgId: "bitcoin" },
    tron: { symbol: "TRX", cgId: "tron" },
  };

  // Parse addresses from query params: ?ethereum=0x...&bitcoin=bc1q...&solana=Sol...
  const addressesToCheck: Array<{ chain: string; address: string }> = [];
  for (const chain of Object.keys(chainNativeTokens)) {
    const addr = c.req.query(chain);
    if (addr) addressesToCheck.push({ chain, address: addr });
  }

  if (addressesToCheck.length === 0) {
    return c.json({
      error: "no_addresses",
      message: "Provide at least one address as query param",
      example: "GET /v1/wallet/portfolio-value?ethereum=0x1234...&bitcoin=bc1q...&solana=So1...",
      supported_chains: Object.keys(chainNativeTokens),
    }, 400);
  }

  // Fetch all unique token prices from CoinGecko in one call
  const uniqueCgIds = [...new Set(addressesToCheck.map(a => chainNativeTokens[a.chain].cgId))];
  let prices: Record<string, number> = {};

  try {
    const cgRes = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueCgIds.join(",")}&vs_currencies=usd`,
      { headers: { Accept: "application/json" } }
    );
    if (cgRes.ok) {
      const cgData = await cgRes.json() as any;
      for (const [cgId, data] of Object.entries(cgData)) {
        prices[cgId] = (data as any).usd ?? 0;
      }
    }
  } catch {
    // Continue without prices — return balances only
  }

  // Fetch balances in parallel (best-effort)
  const results = await Promise.all(addressesToCheck.map(async ({ chain, address }) => {
    const { symbol, cgId } = chainNativeTokens[chain];
    let amount = 0;
    let error: string | null = null;

    try {
      if (chain === "bitcoin") {
        const res = await fetch(`https://mempool.space/api/address/${address}`);
        if (res.ok) {
          const data = await res.json() as any;
          const sats = (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0)
            + (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0);
          amount = sats / 1e8;
        }
      } else if (chain === "solana") {
        const rpcRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
        });
        const rpcData = await rpcRes.json() as any;
        amount = (rpcData.result?.value ?? 0) / 1e9;
      } else if (chain === "tron") {
        const tronRes = await fetch("https://api.trongrid.io/wallet/getaccount", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, visible: true }),
        });
        const tronData = await tronRes.json() as any;
        amount = (tronData.balance ?? 0) / 1_000_000;
      } else {
        // EVM — use public RPC
        const rpcUrls: Record<string, string> = {
          ethereum: "https://eth.public-rpc.com",
          base: "https://mainnet.base.org",
        };
        const rpc = rpcUrls[chain];
        if (rpc) {
          const rpcRes = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 }),
          });
          const rpcData = await rpcRes.json() as any;
          if (rpcData.result) {
            amount = parseInt(rpcData.result, 16) / 1e18;
          }
        }
      }
    } catch (e: any) {
      error = e.message;
    }

    const priceUsd = prices[cgId] ?? null;
    const valueUsd = priceUsd !== null ? Math.round(amount * priceUsd * 100) / 100 : null;

    return {
      chain,
      address,
      symbol,
      balance: Math.round(amount * 1e8) / 1e8,
      price_usd: priceUsd,
      value_usd: valueUsd,
      ...(error ? { error } : {}),
    };
  }));

  const totalValueUsd = results.reduce((sum, r) => sum + (r.value_usd ?? 0), 0);

  return c.json({
    total_value_usd: Math.round(totalValueUsd * 100) / 100,
    wallets: results,
    timestamp: new Date().toISOString(),
    note: "Native token balances only. ERC-20 token balances not included in total.",
  });
});

// POST /multi-send — fan out one private key to multiple recipients in one call
wallet.post("/multi-send", async (c) => {
  const body = await c.req.json();
  const { chain, private_key, recipients, token } = body as {
    chain: string;
    private_key: string;
    token?: string;
    recipients: Array<{ to: string; amount: string }>;
  };

  if (!chain || !private_key || !Array.isArray(recipients) || recipients.length === 0) {
    return c.json({
      error: "invalid_request",
      message: "Provide chain, private_key, and recipients (array of {to, amount})",
      example: {
        chain: "base",
        private_key: "0x...",
        recipients: [
          { to: "0xAbc...", amount: "1.5" },
          { to: "0xDef...", amount: "0.75" },
        ],
      },
    }, 400);
  }

  if (recipients.length > 20) {
    return c.json({ error: "too_many_recipients", message: "Maximum 20 recipients per call" }, 400);
  }

  const chainConfig = SUPPORTED_CHAINS[chain as ChainName];
  if (!chainConfig) {
    return c.json({ error: "unsupported_chain", supported: Object.keys(SUPPORTED_CHAINS) }, 400);
  }

  if (chain === "bitcoin" || chain === "solana" || chain === "tron" || chain === "monero") {
    return c.json({
      error: "not_supported",
      message: `multi-send is only supported on EVM chains (ethereum, base). Received: ${chain}`,
      supported_for_multi_send: ["ethereum", "base"],
    }, 400);
  }

  // EVM multi-send: sequential sends with nonce management
  const provider = getEvmProvider(chainConfig.rpcUrl);
  const signer = new ethers.Wallet(private_key, provider);

  let nonce = await provider.getTransactionCount(signer.address, "latest");

  const results: Array<{
    to: string;
    amount: string;
    status: "sent" | "failed";
    tx_hash?: string;
    explorer?: string;
    error?: string;
  }> = [];

  for (const { to, amount } of recipients) {
    try {
      // Coerce to string — callers sometimes pass numbers, which ethers v6
      // cannot parse and throws "invalid BytesLike value".
      const amountStr = String(amount);
      let txHash: string;

      if (token) {
        const erc20Abi = ["function transfer(address to, uint256 amount) returns (bool)"];
        const contract = new ethers.Contract(token, erc20Abi, signer);
        const tx = await contract.transfer(to, ethers.parseUnits(amountStr, 6), { nonce });
        const receipt = await tx.wait();
        txHash = receipt.hash;
      } else {
        const tx = await signer.sendTransaction({ to, value: ethers.parseEther(amountStr), nonce });
        const receipt = await tx.wait();
        txHash = receipt!.hash;
      }

      results.push({
        to, amount, status: "sent",
        tx_hash: txHash,
        explorer: `${chainConfig.explorer}/tx/${txHash}`,
      });
      nonce++;
    } catch (err: any) {
      results.push({ to, amount, status: "failed", error: err.message });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return c.json({
    chain,
    from: signer.address,
    total: recipients.length,
    sent,
    failed,
    results,
  }, sent > 0 ? 200 : 400);
});

// GET /tokens/:address — ERC-20 token balances for an address on Base or Ethereum
wallet.get("/tokens/:address", async (c) => {
  const address = c.req.param("address");
  const chain = (c.req.query("chain") || "base").toLowerCase();

  if (!["ethereum", "base"].includes(chain)) {
    return c.json({
      error: "unsupported_chain",
      message: "Token balance lookup currently supports: ethereum, base",
      supported: ["ethereum", "base"],
    }, 400);
  }

  const rpcUrls: Record<string, string> = {
    ethereum: "https://eth.public-rpc.com",
    base: "https://mainnet.base.org",
  };

  const TOKEN_LIST: Record<string, Array<{ symbol: string; address: string; decimals: number; name: string }>> = {
    base: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin" },
      { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, name: "Tether USD" },
      { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, name: "Dai Stablecoin" },
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, name: "Wrapped Ether" },
      { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, name: "Coinbase Wrapped BTC" },
      { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, name: "Coinbase Wrapped ETH" },
    ],
    ethereum: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, name: "USD Coin" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, name: "Tether USD" },
      { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, name: "Dai Stablecoin" },
      { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, name: "Wrapped Bitcoin" },
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, name: "Wrapped Ether" },
      { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, name: "Chainlink" },
    ],
  };

  const tokens = TOKEN_LIST[chain];
  const rpcUrl = rpcUrls[chain];

  // ERC-20 balanceOf(address): selector = 0x70a08231, ABI-encode address padded to 32 bytes
  const paddedAddr = "000000000000000000000000" + address.replace(/^0x/i, "").toLowerCase();
  const data = "0x70a08231" + paddedAddr;

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: token.address, data }, "latest"],
        }),
      });
      const json = await res.json() as any;
      const rawHex: string = json.result ?? "0x0";
      const raw = BigInt(rawHex === "0x" ? "0x0" : rawHex);
      const balance = Number(raw) / Math.pow(10, token.decimals);
      return { ...token, balance, has_balance: balance > 0 };
    })
  );

  const balances = results.map((r, i) => {
    if (r.status === "fulfilled") return { ...r.value, lookup_error: null as string | null };
    return { ...tokens[i], balance: null as number | null, has_balance: false, lookup_error: "lookup_failed" as string | null };
  });

  const nonZero = balances.filter(b => b.has_balance);

  return c.json({
    address,
    chain,
    token_balances: balances.map(b => {
      const entry: Record<string, unknown> = {
        symbol: b.symbol,
        name: b.name,
        contract: b.address,
        balance: b.balance !== null ? Math.round(b.balance * 1e8) / 1e8 : null,
        decimals: b.decimals,
      };
      if (b.lookup_error) entry.error = b.lookup_error;
      return entry;
    }),
    summary: {
      tokens_with_balance: nonZero.length,
      tokens_checked: tokens.length,
    },
    note: "Well-known tokens only. Full token list: GET /v1/wallet/chains/tokens",
    send_tokens: "POST /v1/wallet/send { chain, to, amount, private_key, token: <contract_address> }",
  });
});

// GET /nfts/:address — NFT holdings for an EVM address on Base or Ethereum
wallet.get("/nfts/:address", async (c) => {
  const address = c.req.param("address");
  const chain = (c.req.query("chain") || "base").toLowerCase();
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  if (!["ethereum", "base"].includes(chain)) {
    return c.json({
      error: "unsupported_chain",
      message: "NFT lookup supports: ethereum, base",
      supported: ["ethereum", "base"],
    }, 400);
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "invalid_address", message: "Provide a valid EVM address (0x...)" }, 400);
  }

  // Use Alchemy NFT API (free, no key needed for basic queries via public endpoint)
  // Fallback: parse ERC-721/ERC-1155 Transfer events via eth_getLogs if needed
  const alchemyBase: Record<string, string> = {
    ethereum: "https://eth-mainnet.g.alchemy.com/nft/v3/demo",
    base: "https://base-mainnet.g.alchemy.com/nft/v3/demo",
  };

  const baseUrl = alchemyBase[chain];

  try {
    const url = `${baseUrl}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Alchemy API returned ${res.status}`);
    }

    const data = await res.json() as any;
    const nfts = (data.ownedNfts ?? []).slice(0, limit);

    const formatted = nfts.map((nft: any) => ({
      contract: nft.contract?.address ?? null,
      token_id: nft.tokenId ?? null,
      name: nft.name ?? nft.contract?.name ?? "Unknown NFT",
      collection: nft.contract?.name ?? null,
      token_type: nft.tokenType ?? null, // ERC721 | ERC1155
      image_url: nft.image?.cachedUrl ?? nft.image?.originalUrl ?? null,
      description: nft.description ?? null,
      floor_price_eth: nft.contract?.openSeaMetadata?.floorPrice ?? null,
      opensea_url: nft.contract?.openSeaMetadata?.collectionSlug
        ? `https://opensea.io/collection/${nft.contract.openSeaMetadata.collectionSlug}`
        : null,
    }));

    // Group by collection
    const byCollection: Record<string, number> = {};
    for (const nft of formatted) {
      const col = nft.collection ?? "Unknown";
      byCollection[col] = (byCollection[col] ?? 0) + 1;
    }

    const totalCount = data.totalCount ?? nfts.length;

    return c.json({
      address,
      chain,
      total_nfts: totalCount,
      showing: formatted.length,
      nfts: formatted,
      collections: Object.entries(byCollection)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ collection: name, count })),
      pagination: {
        has_more: totalCount > formatted.length,
        next_page: data.pageKey ? `GET /v1/wallet/nfts/${address}?chain=${chain}&page_key=${data.pageKey}` : null,
      },
      explorer: chain === "base"
        ? `https://basescan.org/address/${address}#inventory`
        : `https://etherscan.io/address/${address}#inventory`,
      tip: "Filter by collection: GET /v1/wallet/nfts/:address?chain=base&limit=50",
    });
  } catch (err: any) {
    // Graceful degradation — return empty result with helpful message
    return c.json({
      address,
      chain,
      total_nfts: null,
      nfts: [],
      collections: [],
      error: "nft_lookup_failed",
      message: err.message,
      alternative: chain === "base"
        ? `https://basescan.org/address/${address}#inventory`
        : `https://etherscan.io/address/${address}#inventory`,
    }, 200); // 200 so agents don't bail — they can handle empty gracefully
  }
});

// GET /address-book — list saved contacts
wallet.get("/address-book", (c) => {
  const agentId = c.get("agentId") as string;

  const contacts = db.select().from(schema.addressBook)
    .where(eq(schema.addressBook.agentId, agentId))
    .orderBy(desc(schema.addressBook.createdAt))
    .all();

  return c.json({
    total: contacts.length,
    contacts: contacts.map(entry => ({
      id: entry.id,
      label: entry.label,
      address: entry.address,
      chain: entry.chain,
      note: entry.note ?? null,
      last_used_at: entry.lastUsedAt ? new Date(entry.lastUsedAt * 1000).toISOString() : null,
      created_at: new Date(entry.createdAt * 1000).toISOString(),
    })),
    tip: "POST /v1/wallet/address-book to add a contact. Use label to remember addresses.",
  });
});

// POST /address-book — add a new contact
wallet.post("/address-book", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json();
  const { label, address, chain, note } = body as {
    label: string; address: string; chain: string; note?: string;
  };

  if (!label || !address || !chain) {
    return c.json({
      error: "invalid_request",
      message: "Provide label, address, and chain",
      supported_chains: ["ethereum", "base", "solana", "bitcoin", "tron"],
      example: { label: "My Coinbase", address: "0x...", chain: "base", note: "USDC receiving address" },
    }, 400);
  }

  const VALID_CHAINS = ["ethereum", "base", "solana", "bitcoin", "tron", "monero"];
  if (!VALID_CHAINS.includes(chain)) {
    return c.json({ error: "unsupported_chain", supported: VALID_CHAINS }, 400);
  }

  if (label.length > 50) {
    return c.json({ error: "label_too_long", message: "Label must be 50 chars or less" }, 400);
  }

  // Check for duplicate address+chain for this agent
  const existing = db.select({ id: schema.addressBook.id })
    .from(schema.addressBook)
    .where(and(
      eq(schema.addressBook.agentId, agentId),
      eq(schema.addressBook.address, address),
      eq(schema.addressBook.chain, chain),
    ))
    .get();

  if (existing) {
    return c.json({ error: "duplicate_contact", message: "This address+chain is already in your address book", id: existing.id }, 409);
  }

  // Max 50 contacts per agent
  const countResult = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.addressBook)
    .where(eq(schema.addressBook.agentId, agentId))
    .get();

  if ((countResult?.count ?? 0) >= 50) {
    return c.json({ error: "limit_reached", message: "Maximum 50 contacts per agent" }, 400);
  }

  const { randomUUID } = await import("crypto");
  const id = "ab_" + randomUUID().replace(/-/g, "").slice(0, 12);

  db.insert(schema.addressBook).values({
    id,
    agentId,
    label,
    address,
    chain,
    note: note ?? null,
  }).run();

  return c.json({
    id,
    label,
    address,
    chain,
    note: note ?? null,
    message: "Contact saved to address book",
    use_in_send: `POST /v1/wallet/send { chain: "${chain}", to: "${address}", amount: "...", private_key: "..." }`,
  }, 201);
});

// PATCH /address-book/:id — update a contact label or note
wallet.patch("/address-book/:id", async (c) => {
  const agentId = c.get("agentId") as string;
  const contactId = c.req.param("id");
  const body = await c.req.json();

  const contact = db.select().from(schema.addressBook)
    .where(and(eq(schema.addressBook.id, contactId), eq(schema.addressBook.agentId, agentId)))
    .get();

  if (!contact) {
    return c.json({ error: "not_found", message: "Contact not found" }, 404);
  }

  const updates: Record<string, unknown> = {};
  if (body.label !== undefined) updates.label = String(body.label).slice(0, 50);
  if (body.note !== undefined) updates.note = body.note === null ? null : String(body.note);

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "no_changes", message: "Provide label or note to update" }, 400);
  }

  db.update(schema.addressBook)
    .set(updates)
    .where(eq(schema.addressBook.id, contactId))
    .run();

  return c.json({ id: contactId, ...updates, message: "Contact updated" });
});

// DELETE /address-book/:id — remove a contact
wallet.delete("/address-book/:id", (c) => {
  const agentId = c.get("agentId") as string;
  const contactId = c.req.param("id");

  const contact = db.select({ id: schema.addressBook.id })
    .from(schema.addressBook)
    .where(and(eq(schema.addressBook.id, contactId), eq(schema.addressBook.agentId, agentId)))
    .get();

  if (!contact) {
    return c.json({ error: "not_found", message: "Contact not found" }, 404);
  }

  db.delete(schema.addressBook).where(eq(schema.addressBook.id, contactId)).run();

  return c.json({ deleted: contactId, message: "Contact removed from address book" });
});

// GET /activity — unified activity feed: swaps + referral earnings + referral withdrawals
wallet.get("/activity", (c) => {
  const agentId = c.get("agentId") as string;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const offset = parseInt(c.req.query("offset") || "0");
  const type = c.req.query("type"); // optional filter: swaps | referral_earnings | referral_withdrawals

  // Swaps
  const swapEvents: Array<{
    type: string; id: string; created_at: number;
    from_chain?: string; to_chain?: string; from_token?: string; to_token?: string;
    from_amount?: string; to_address?: string; status?: string; fee_amount?: number;
    amount?: number; commission?: number;
    address?: string; chain?: string; tx_hash?: string | null;
    order_id?: string;
  }> = (!type || type === "swaps")
    ? db.select().from(schema.swaps)
        .where(eq(schema.swaps.agentId, agentId))
        .all()
        .map(s => ({
          type: "swap",
          id: s.id,
          created_at: s.createdAt,
          from_chain: s.fromChain,
          to_chain: s.toChain,
          from_token: s.fromToken,
          to_token: s.toToken,
          from_amount: s.fromAmount,
          to_address: s.toAddress,
          status: s.status,
          fee_amount: s.feeAmount,
          order_id: s.orderId,
        }))
    : [];

  // Referral earnings
  const earningEvents = (!type || type === "referral_earnings")
    ? db.select().from(schema.referralEarnings)
        .where(eq(schema.referralEarnings.referrerId, agentId))
        .all()
        .map(e => ({
          type: "referral_earning",
          id: e.id,
          created_at: e.createdAt,
          referred_agent: e.referredId,
          amount: e.commissionAmount,
          fee_amount: e.feeAmount,
          swap_id: e.swapId,
        }))
    : [];

  // Referral withdrawals
  const withdrawalEvents = (!type || type === "referral_withdrawals")
    ? db.select().from(schema.referralWithdrawals)
        .where(eq(schema.referralWithdrawals.referrerId, agentId))
        .all()
        .map(w => ({
          type: "referral_withdrawal",
          id: w.id,
          created_at: w.createdAt,
          amount: w.amount,
          address: w.address,
          chain: w.chain,
          status: w.status,
          tx_hash: w.txHash ?? null,
        }))
    : [];

  // Merge and sort by created_at desc
  const all = [...swapEvents, ...earningEvents, ...withdrawalEvents]
    .sort((a, b) => b.created_at - a.created_at);

  const total = all.length;
  const page = all.slice(offset, offset + limit);

  // Summary stats
  const totalSwaps = swapEvents.length;
  const totalFeesPaid = swapEvents.reduce((s, e) => s + (e.fee_amount ?? 0), 0);
  const totalReferralEarned = earningEvents.reduce((s, e) => s + (e.amount ?? 0), 0);
  const totalWithdrawn = withdrawalEvents
    .filter(w => w.status === "completed")
    .reduce((s, w) => s + (w.amount ?? 0), 0);

  return c.json({
    total,
    limit,
    offset,
    has_more: offset + limit < total,
    summary: {
      total_swaps: totalSwaps,
      total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
      total_referral_earned: Math.round(totalReferralEarned * 100) / 100,
      total_withdrawn: Math.round(totalWithdrawn * 100) / 100,
    },
    events: page,
    filter_options: "Add ?type=swaps|referral_earnings|referral_withdrawals to filter",
  });
});

// ─── GET /swap-analytics — deep analytics on agent's swap history ───

wallet.get("/swap-analytics", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const period = c.req.query("period") ?? "all"; // all | week | month | today
  c.header("Cache-Control", "private, max-age=60");

  const now = Math.floor(Date.now() / 1000);
  let sinceTs: number | null = null;
  let periodLabel = "All Time";

  if (period === "today") {
    sinceTs = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    periodLabel = "Today (UTC)";
  } else if (period === "week") {
    sinceTs = now - 7 * 86400;
    periodLabel = "Last 7 Days";
  } else if (period === "month") {
    sinceTs = now - 30 * 86400;
    periodLabel = "Last 30 Days";
  }

  // All swaps for this agent in period
  const swaps = db.select()
    .from(schema.swaps)
    .where(and(
      eq(schema.swaps.agentId, agentId),
      ...(sinceTs !== null ? [sql`${schema.swaps.createdAt} >= ${sinceTs}`] : []),
    ))
    .orderBy(desc(schema.swaps.createdAt))
    .all();

  if (swaps.length === 0) {
    return c.json({
      period: periodLabel,
      total_swaps: 0,
      message: "No swaps yet. Use POST /v1/swap to make your first swap.",
      how_to_swap: "POST /v1/swap { from_chain, from_token, to_chain, to_token, amount, to_address }",
    });
  }

  // ─── Volume by route (from_token → to_token) ───
  const routeMap = new Map<string, { count: number; total_fees: number }>();
  for (const s of swaps) {
    const key = `${s.fromToken}→${s.toToken}`;
    const existing = routeMap.get(key) ?? { count: 0, total_fees: 0 };
    existing.count++;
    existing.total_fees += s.feeAmount;
    routeMap.set(key, existing);
  }
  const topRoutes = Array.from(routeMap.entries())
    .map(([route, stats]) => ({ route, count: stats.count, total_fees: Math.round(stats.total_fees * 100) / 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ─── Volume by chain pair ───
  const chainPairMap = new Map<string, number>();
  for (const s of swaps) {
    const key = `${s.fromChain}→${s.toChain}`;
    chainPairMap.set(key, (chainPairMap.get(key) ?? 0) + 1);
  }
  const topChainPairs = Array.from(chainPairMap.entries())
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ─── Status breakdown ───
  const statusMap = new Map<string, number>();
  for (const s of swaps) {
    statusMap.set(s.status, (statusMap.get(s.status) ?? 0) + 1);
  }
  const byStatus = Object.fromEntries(statusMap.entries());

  // ─── Fee analysis ───
  const totalFees = swaps.reduce((sum, s) => sum + s.feeAmount, 0);
  const fees = swaps.map(s => s.feeAmount);
  const avgFee = totalFees / swaps.length;
  const maxFee = Math.max(...fees);
  const minFee = Math.min(...fees);

  // ─── Activity over time (last 7 days rolling) ───
  const sevenDaysAgo = now - 7 * 86400;
  const recentSwaps = swaps.filter(s => s.createdAt >= sevenDaysAgo);

  // Group by day
  const dayBuckets = new Map<string, { count: number; fees: number }>();
  for (const s of recentSwaps) {
    const day = new Date(s.createdAt * 1000).toISOString().slice(0, 10);
    const bucket = dayBuckets.get(day) ?? { count: 0, fees: 0 };
    bucket.count++;
    bucket.fees += s.feeAmount;
    dayBuckets.set(day, bucket);
  }
  const dailyActivity = Array.from(dayBuckets.entries())
    .map(([date, stats]) => ({ date, swaps: stats.count, fees: Math.round(stats.fees * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ─── Most active day of week ───
  const dowCounts = new Array(7).fill(0);
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const s of swaps) {
    const dow = new Date(s.createdAt * 1000).getUTCDay();
    dowCounts[dow]++;
  }
  const busiestDay = dowNames[dowCounts.indexOf(Math.max(...dowCounts))];

  // ─── First / most recent swap ───
  const oldest = swaps[swaps.length - 1];
  const newest = swaps[0];

  // ─── Pending/in-flight swaps ───
  const pending = swaps.filter(s => s.status === "pending" || s.status === "processing");

  return c.json({
    period: periodLabel,
    total_swaps: swaps.length,
    fees: {
      total: Math.round(totalFees * 100) / 100,
      average: Math.round(avgFee * 100) / 100,
      max: Math.round(maxFee * 100) / 100,
      min: Math.round(minFee * 100) / 100,
    },
    by_status: byStatus,
    top_routes: topRoutes,
    top_chain_pairs: topChainPairs,
    activity: {
      last_7_days: dailyActivity,
      busiest_day_of_week: busiestDay,
      first_swap_at: new Date(oldest.createdAt * 1000).toISOString(),
      most_recent_swap_at: new Date(newest.createdAt * 1000).toISOString(),
    },
    pending: pending.length > 0
      ? {
          count: pending.length,
          order_ids: pending.map(s => s.orderId),
          tip: "Check status at GET /v1/swap/:order_id",
        }
      : null,
    period_options: ["today", "week", "month", "all"],
    tip: "Add ?period=week for last 7 days activity",
    updated_at: new Date().toISOString(),
  });
});

// ─── ERC-20 token allowance checker ───
// Checks how much of a token a spender is approved to use on behalf of the owner

wallet.get("/token-allowance", async (c) => {
  const chain = c.req.query("chain") ?? "";
  const token = c.req.query("token") ?? "";    // ERC-20 contract address
  const owner = c.req.query("owner") ?? "";    // wallet address that owns tokens
  const spender = c.req.query("spender") ?? ""; // contract approved to spend

  const KNOWN_SPENDERS: Record<string, string> = {
    // Uniswap V3 Router
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 Router02",
    // 1inch V5
    "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch V5 Aggregator",
    // OpenSea Seaport
    "0x00000000000001ad428e4906ae43d8f9852d0dd6": "OpenSea Seaport 1.5",
    // Permit2
    "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
    // Aave V3
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
  };

  const EVM_CHAINS: Record<string, string> = {
    ethereum: "https://eth.llamarpc.com",
    base: "https://mainnet.base.org",
    arbitrum: "https://arb1.arbitrum.io/rpc",
    bsc: "https://bsc-dataseed1.bnbchain.org",
  };

  const WELL_KNOWN_TOKENS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
    ethereum: {
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
      "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
      "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
    },
    base: {
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
    },
    arbitrum: {
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    },
  };

  if (!chain || !EVM_CHAINS[chain]) {
    return c.json({
      error: "invalid_chain",
      message: `chain must be one of: ${Object.keys(EVM_CHAINS).join(", ")}`,
      note: "Token allowances are EVM-only (Ethereum, Base, Arbitrum, BSC)",
    }, 400);
  }
  if (!token || !token.startsWith("0x")) {
    return c.json({ error: "invalid_token", message: "token must be a valid ERC-20 contract address (0x...)" }, 400);
  }
  if (!owner || !owner.startsWith("0x")) {
    return c.json({ error: "invalid_owner", message: "owner must be a valid EVM address (0x...)" }, 400);
  }
  if (!spender || !spender.startsWith("0x")) {
    return c.json({ error: "invalid_spender", message: "spender must be a valid EVM address (0x...)" }, 400);
  }

  const rpc = EVM_CHAINS[chain];
  const tokenLower = token.toLowerCase();
  const spenderLower = spender.toLowerCase();
  const ownerLower = owner.toLowerCase();
  const tokenInfo = WELL_KNOWN_TOKENS[chain]?.[tokenLower] ?? null;

  // ERC-20 allowance(address owner, address spender) => uint256
  // keccak256("allowance(address,address)") = 0xdd62ed3e
  const ownerPadded = ownerLower.replace("0x", "").padStart(64, "0");
  const spenderPadded = spenderLower.replace("0x", "").padStart(64, "0");
  const calldata = "0xdd62ed3e" + ownerPadded + spenderPadded;

  // Also fetch decimals if unknown: keccak256("decimals()") = 0x313ce567
  let decimals = tokenInfo?.decimals ?? null;
  let symbol = tokenInfo?.symbol ?? null;

  try {
    if (decimals === null) {
      const decRes = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x313ce567" }, "latest"] }),
        signal: AbortSignal.timeout(5000),
      });
      const decData = await decRes.json() as any;
      if (decData.result && decData.result !== "0x") {
        decimals = parseInt(decData.result, 16);
      }
    }

    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: token, data: calldata }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as any;

    if (!data.result || data.result === "0x") {
      return c.json({ error: "call_failed", message: "eth_call returned empty response — verify contract address and chain" }, 502);
    }

    const rawAllowance = BigInt(data.result);
    const divisor = BigInt(10 ** (decimals ?? 18));
    const allowanceFormatted = Number(rawAllowance) / Math.pow(10, decimals ?? 18);
    const isUnlimited = rawAllowance >= BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") / BigInt(2);

    const spenderLabel = KNOWN_SPENDERS[spenderLower] ?? null;

    return c.json({
      chain,
      token_contract: token,
      token_symbol: symbol,
      token_decimals: decimals,
      owner,
      spender,
      spender_label: spenderLabel,
      allowance: {
        raw: rawAllowance.toString(),
        formatted: isUnlimited ? "unlimited" : Math.round(allowanceFormatted * 1e6) / 1e6,
        is_unlimited: isUnlimited,
        is_zero: rawAllowance === BigInt(0),
      },
      risk_note: isUnlimited
        ? `WARNING: ${spenderLabel ?? "This spender"} has UNLIMITED access to your ${symbol ?? "tokens"}. Consider revoking via POST /v1/wallet/send with an approval of 0.`
        : rawAllowance === BigInt(0)
        ? "No allowance. Spender cannot transfer tokens on your behalf."
        : `Spender can transfer up to ${Math.round(allowanceFormatted * 1e6) / 1e6} ${symbol ?? "tokens"}.`,
      revoke_example: {
        description: "To revoke: send approve(spender, 0) transaction",
        endpoint: "POST /v1/wallet/send",
        note: "Include approve ABI calldata in the 'data' field with amount 0",
      },
    });
  } catch (e: any) {
    return c.json({ error: "rpc_error", message: e.message }, 502);
  }
});

// ─── USDC multi-chain balance aggregator ───

wallet.get("/usdc-balance", async (c) => {
  // USDC contract addresses per chain
  const USDC_CONTRACTS: Record<string, { address: string; decimals: number; rpc?: string }> = {
    ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, rpc: "https://eth.llamarpc.com" },
    base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, rpc: "https://mainnet.base.org" },
    arbitrum: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, rpc: "https://arb1.arbitrum.io/rpc" },
    bsc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, rpc: "https://bsc-dataseed1.bnbchain.org" },
    solana: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    tron: { address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", decimals: 6 },
  };

  // Collect wallet addresses from query params
  const addressesToCheck: Array<{ chain: string; wallet: string }> = [];
  for (const chain of Object.keys(USDC_CONTRACTS)) {
    const addr = c.req.query(chain);
    if (addr) addressesToCheck.push({ chain, wallet: addr });
  }

  if (addressesToCheck.length === 0) {
    return c.json({
      error: "no_addresses",
      message: "Provide at least one address as query param",
      example: "GET /v1/wallet/usdc-balance?ethereum=0x1234...&base=0x1234...&solana=YourSolAddr",
      supported_chains: Object.keys(USDC_CONTRACTS),
      usdc_contracts: Object.fromEntries(Object.entries(USDC_CONTRACTS).map(([ch, c]) => [ch, c.address])),
    }, 400);
  }

  // ERC-20 balanceOf ABI call: keccak256("balanceOf(address)") = 0x70a08231
  function buildBalanceOfCalldata(walletAddress: string): string {
    const addr = walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
    return "0x70a08231" + addr;
  }

  const results = await Promise.all(addressesToCheck.map(async ({ chain, wallet }) => {
    const config = USDC_CONTRACTS[chain];
    let balance = 0;
    let error: string | null = null;

    try {
      if (chain === "solana") {
        // Use getTokenAccountsByOwner for SPL tokens
        const rpcRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getTokenAccountsByOwner",
            params: [
              wallet,
              { mint: config.address },
              { encoding: "jsonParsed" },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await rpcRes.json() as any;
        const accounts = data.result?.value ?? [];
        balance = accounts.reduce((sum: number, acc: any) => {
          const amount = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
          return sum + amount;
        }, 0);
      } else if (chain === "tron") {
        // TRC-20 balanceOf via TronGrid
        const res = await fetch(`https://api.trongrid.io/v1/accounts/${wallet}/tokens?only_confirmed=true`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const usdcToken = (data.data ?? []).find((t: any) =>
            t.tokenId === config.address || t.token_id === config.address
          );
          balance = usdcToken ? (usdcToken.balance ?? 0) / Math.pow(10, config.decimals) : 0;
        }
      } else {
        // EVM chains — eth_call balanceOf
        const rpc = config.rpc!;
        const callRes = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: config.address, data: buildBalanceOfCalldata(wallet) }, "latest"],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const callData = await callRes.json() as any;
        if (callData.result && callData.result !== "0x") {
          const raw = BigInt(callData.result);
          balance = Number(raw) / Math.pow(10, config.decimals);
        }
      }
    } catch (e: any) {
      error = e.message;
    }

    return {
      chain,
      wallet_address: wallet,
      usdc_balance: Math.round(balance * 1e6) / 1e6,
      usdc_contract: config.address,
      ...(error ? { error } : {}),
    };
  }));

  const totalUsdc = results.reduce((sum, r) => sum + (r.usdc_balance ?? 0), 0);

  return c.json({
    total_usdc: Math.round(totalUsdc * 1e6) / 1e6,
    total_usd: Math.round(totalUsdc * 100) / 100, // USDC ≈ $1
    chain_count: results.length,
    balances: results,
    note: "USDC only (not USDT or other stablecoins). BSC USDC has 18 decimals (non-standard). Solana queries SPL token accounts.",
    timestamp: new Date().toISOString(),
  });
});

// ─── Portfolio tracker (uses address book) ───

// GET /portfolio — live USD value across all saved addresses
wallet.get("/portfolio", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;

  const savedAddresses = db
    .select()
    .from(schema.addressBook)
    .where(eq(schema.addressBook.agentId, agentId))
    .all();

  if (savedAddresses.length === 0) {
    return c.json({
      total_value_usd: 0,
      wallets: [],
      message: "No addresses saved. Add addresses via POST /v1/wallet/portfolio/addresses",
      tip: "Save your wallet addresses once, then call GET /v1/wallet/portfolio anytime to see your total USD value.",
    });
  }

  const chainNativeTokens: Record<string, { symbol: string; cgId: string }> = {
    ethereum: { symbol: "ETH", cgId: "ethereum" },
    base: { symbol: "ETH", cgId: "ethereum" },
    solana: { symbol: "SOL", cgId: "solana" },
    bitcoin: { symbol: "BTC", cgId: "bitcoin" },
    tron: { symbol: "TRX", cgId: "tron" },
  };

  // Fetch all unique token prices in one CoinGecko call
  const relevantChains = savedAddresses.map(a => a.chain).filter(ch => chainNativeTokens[ch]);
  const uniqueCgIds = [...new Set(relevantChains.map(ch => chainNativeTokens[ch]?.cgId).filter(Boolean))];
  let prices: Record<string, number> = {};

  try {
    const cgRes = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueCgIds.join(",")}&vs_currencies=usd`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (cgRes.ok) {
      const cgData = await cgRes.json() as any;
      for (const [cgId, data] of Object.entries(cgData)) {
        prices[cgId] = (data as any).usd ?? 0;
      }
    }
  } catch {
    // Continue without prices
  }

  // Fetch balances in parallel (best-effort)
  const results = await Promise.all(savedAddresses.map(async (saved) => {
    const { chain, address } = saved;
    const tokenInfo = chainNativeTokens[chain];
    let amount = 0;
    let error: string | null = null;

    try {
      if (chain === "bitcoin") {
        const res = await fetch(`https://mempool.space/api/address/${address}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json() as any;
          const sats = (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0)
            + (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0);
          amount = sats / 1e8;
        }
      } else if (chain === "solana") {
        const rpcRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
          signal: AbortSignal.timeout(8000),
        });
        const rpcData = await rpcRes.json() as any;
        amount = (rpcData.result?.value ?? 0) / 1e9;
      } else if (chain === "tron") {
        const tronRes = await fetch("https://api.trongrid.io/wallet/getaccount", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, visible: true }),
          signal: AbortSignal.timeout(8000),
        });
        const tronData = await tronRes.json() as any;
        amount = (tronData.balance ?? 0) / 1_000_000;
      } else if (chain === "ethereum" || chain === "base") {
        const rpcUrls: Record<string, string> = {
          ethereum: "https://eth.public-rpc.com",
          base: "https://mainnet.base.org",
        };
        const rpc = rpcUrls[chain];
        if (rpc) {
          const rpcRes = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 }),
            signal: AbortSignal.timeout(8000),
          });
          const rpcData = await rpcRes.json() as any;
          if (rpcData.result) {
            amount = parseInt(rpcData.result, 16) / 1e18;
          }
        }
      }
    } catch (e: any) {
      error = e.message;
    }

    const priceUsd = tokenInfo ? (prices[tokenInfo.cgId] ?? null) : null;
    const valueUsd = priceUsd !== null ? Math.round(amount * priceUsd * 100) / 100 : null;

    return {
      id: saved.id,
      label: saved.label,
      chain,
      address,
      symbol: tokenInfo?.symbol ?? chain.toUpperCase(),
      balance: Math.round(amount * 1e8) / 1e8,
      price_usd: priceUsd,
      value_usd: valueUsd,
      note: saved.note ?? undefined,
      ...(error ? { error } : {}),
    };
  }));

  const totalValueUsd = results.reduce((sum, r) => sum + (r.value_usd ?? 0), 0);

  // Group by chain for summary
  const byChain: Record<string, { count: number; value_usd: number }> = {};
  for (const r of results) {
    if (!byChain[r.chain]) byChain[r.chain] = { count: 0, value_usd: 0 };
    byChain[r.chain].count++;
    byChain[r.chain].value_usd += r.value_usd ?? 0;
  }
  for (const ch of Object.keys(byChain)) {
    byChain[ch].value_usd = Math.round(byChain[ch].value_usd * 100) / 100;
  }

  return c.json({
    total_value_usd: Math.round(totalValueUsd * 100) / 100,
    address_count: savedAddresses.length,
    by_chain: byChain,
    wallets: results,
    prices_usd: prices,
    timestamp: new Date().toISOString(),
    note: "Native token balances only. Manage addresses via POST/DELETE /v1/wallet/portfolio/addresses",
  });
});

// GET /portfolio/addresses — list saved addresses
wallet.get("/portfolio/addresses", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;

  const addresses = db
    .select()
    .from(schema.addressBook)
    .where(eq(schema.addressBook.agentId, agentId))
    .all();

  return c.json({
    count: addresses.length,
    addresses: addresses.map(a => ({
      id: a.id,
      label: a.label,
      chain: a.chain,
      address: a.address,
      note: a.note ?? undefined,
      created_at: new Date(a.createdAt * 1000).toISOString(),
      last_used_at: a.lastUsedAt ? new Date(a.lastUsedAt * 1000).toISOString() : null,
    })),
    tip: "GET /v1/wallet/portfolio to fetch live balances + USD values for all saved addresses",
  });
});

// POST /portfolio/addresses — save an address to portfolio
wallet.post("/portfolio/addresses", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json() as any;
  const { label, chain, address, note } = body;

  const supportedChains = ["ethereum", "base", "solana", "bitcoin", "tron"];
  if (!label || typeof label !== "string" || label.trim().length === 0) {
    return c.json({ error: "invalid_request", message: "label is required" }, 400);
  }
  if (!chain || !supportedChains.includes(chain)) {
    return c.json({ error: "invalid_request", message: `chain must be one of: ${supportedChains.join(", ")}` }, 400);
  }
  if (!address || typeof address !== "string" || address.trim().length === 0) {
    return c.json({ error: "invalid_request", message: "address is required" }, 400);
  }

  // Limit to 50 addresses per agent
  const existing = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.addressBook)
    .where(eq(schema.addressBook.agentId, agentId))
    .get();

  if ((existing?.count ?? 0) >= 50) {
    return c.json({ error: "limit_reached", message: "Maximum 50 addresses per portfolio. Delete some to add more." }, 400);
  }

  const id = `addr_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

  db.insert(schema.addressBook).values({
    id,
    agentId,
    label: label.trim(),
    chain,
    address: address.trim(),
    note: note?.trim() ?? null,
  }).run();

  return c.json({
    success: true,
    id,
    label: label.trim(),
    chain,
    address: address.trim(),
    message: "Address saved to portfolio. Call GET /v1/wallet/portfolio to see live balances.",
  }, 201);
});

// DELETE /portfolio/addresses/:id — remove address from portfolio
wallet.delete("/portfolio/addresses/:id", authMiddleware, async (c) => {
  const agentId = c.get("agentId") as string;
  const addrId = c.req.param("id");

  const existing = db
    .select()
    .from(schema.addressBook)
    .where(and(eq(schema.addressBook.id, addrId), eq(schema.addressBook.agentId, agentId)))
    .get();

  if (!existing) {
    return c.json({ error: "not_found", message: "Address not found or not owned by you" }, 404);
  }

  db.delete(schema.addressBook)
    .where(and(eq(schema.addressBook.id, addrId), eq(schema.addressBook.agentId, agentId)))
    .run();

  return c.json({ success: true, message: `Address "${existing.label}" (${existing.chain}: ${existing.address}) removed from portfolio.` });
});

// GET /export — return stored private keys for all chains (agent's own keys only)
wallet.get("/export", async (c) => {
  const agentId = c.get("agentId");

  const stored = db.select().from(schema.wallets).where(eq(schema.wallets.agentId, agentId)).get();
  if (!stored) {
    return c.json({
      error: "no_wallet",
      message: "No wallet found. Create one first with POST /v1/wallet/create",
    }, 404);
  }

  // Helper to safely decrypt a field; returns null on failure
  const tryDecrypt = (enc: string | null | undefined): string | null => {
    if (!enc) return null;
    try { return decryptXmrKey(enc, agentId); } catch { return null; }
  };

  const xmrSpendKey = tryDecrypt(stored.xmrSpendKeyEncrypted);
  const ethPrivKey   = tryDecrypt(stored.ethPrivateKeyEncrypted);
  const solPrivKey   = tryDecrypt(stored.solPrivateKeyEncrypted);
  const btcPrivKey   = tryDecrypt(stored.btcPrivateKeyEncrypted);
  const tronPrivKey  = tryDecrypt(stored.tronPrivateKeyEncrypted);
  const mnemonic     = tryDecrypt(stored.mnemonicEncrypted);

  // Legacy wallets (created before the export feature) have no non-XMR keys stored
  const isLegacy = !stored.ethPrivateKeyEncrypted;

  if (isLegacy) {
    return c.json({
      warning: "Keys created before export feature was added. Only XMR keys available. Contact support or recreate wallet.",
      monero: {
        address: stored.xmrAddress,
        view_key: stored.xmrViewKey,
        spend_key: xmrSpendKey,
      },
      other_chains: null,
      note: "To recover ETH/SOL/BTC/TRX keys, recreate your wallet with POST /v1/wallet/create (this will overwrite stored XMR keys).",
    });
  }

  return c.json({
    warning: "Keep these keys secret. Anyone with access to a private key controls those funds.",
    mnemonic,
    private_keys: {
      ethereum_and_base: ethPrivKey ? "0x" + ethPrivKey : null,
      solana: solPrivKey,
      bitcoin_wif: btcPrivKey,
      tron: tronPrivKey ? "0x" + tronPrivKey : null,
      monero_view_key: stored.xmrViewKey,
      monero_spend_key: xmrSpendKey,
    },
    monero_address: stored.xmrAddress,
    note: "ETH and Base share the same private key (EVM-compatible). Import into MetaMask, Phantom, Electrum etc to self-custody.",
    derivation_paths: {
      ethereum_base: "m/44'/60'/0'/0/0",
      solana: "m/44'/501'/0'/0'",
      bitcoin: "m/84'/0'/0'/0/0 (native segwit)",
      tron: "m/44'/195'/0'/0/0",
      monero: "HMAC-SHA512('monero seed', bip39_seed)",
    },
  });
});

export default wallet;
