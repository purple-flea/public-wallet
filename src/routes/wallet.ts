import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { SUPPORTED_CHAINS, type ChainName } from "../chains/config.js";
import type { AppEnv } from "../types.js";
import * as bip39 from "bip39";
import { ethers } from "ethers";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { createHash } from "crypto";
import { deriveMoneroKeys } from "../chains/monero.js";

const bip32 = BIP32Factory(ecc);


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

  return c.json({
    mnemonic,
    addresses,
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
    },
    tip: "Any address from these paths will accept deposits. Use Base USDC for lowest fees and fastest confirmation.",
    check_balance: "GET /v1/wallet/balance/:your_address?chain=base",
    supported_deposit_chains: ["ethereum", "base", "solana", "bitcoin", "tron"],
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
    return c.json({
      error: "not_supported",
      message: "Monero balance cannot be checked from address alone. Monero encrypts balances on-chain — you need your private view key + a synced node. Use the Monero CLI wallet or MyMonero with your mnemonic.",
      alternative: "Restore wallet with your mnemonic at mymonero.com or monero-wallet-cli",
    }, 422);
  }

  // EVM chains (ethereum, base)
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
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

  if (!chain || !to || !amount || !private_key) {
    return c.json({
      error: "invalid_request",
      message: "Provide chain, to, amount, and private_key",
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
    return c.json({
      error: "not_supported",
      message: "Monero send requires a Monero wallet daemon (monero-wallet-rpc) with a synced node. Use the Monero CLI wallet or MyMonero with your mnemonic to send XMR.",
    }, 422);
  }

  // EVM chains
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
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
  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
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
      let txHash: string;

      if (token) {
        const erc20Abi = ["function transfer(address to, uint256 amount) returns (bool)"];
        const contract = new ethers.Contract(token, erc20Abi, signer);
        const tx = await contract.transfer(to, ethers.parseUnits(amount, 6), { nonce });
        const receipt = await tx.wait();
        txHash = receipt.hash;
      } else {
        const tx = await signer.sendTransaction({ to, value: ethers.parseEther(amount), nonce });
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

export default wallet;
