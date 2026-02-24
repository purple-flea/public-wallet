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

export default wallet;
