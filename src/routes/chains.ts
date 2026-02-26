import { Hono } from "hono";
import { SUPPORTED_CHAINS, WAGYU_CHAIN_IDS } from "../chains/config.js";

const chains = new Hono();

// EVM RPC endpoints for gas price checks
const GAS_CHAINS: Record<string, { name: string; rpc: string; nativeToken: string; chainId: number }> = {
  ethereum: { name: "Ethereum", rpc: "https://eth.llamarpc.com", nativeToken: "ETH", chainId: 1 },
  base: { name: "Base", rpc: "https://mainnet.base.org", nativeToken: "ETH", chainId: 8453 },
  arbitrum: { name: "Arbitrum", rpc: "https://arb1.arbitrum.io/rpc", nativeToken: "ETH", chainId: 42161 },
  bsc: { name: "BSC", rpc: "https://bsc-dataseed.binance.org", nativeToken: "BNB", chainId: 56 },
};

async function fetchGasPrice(chainKey: string): Promise<{
  chain: string;
  chain_id: number;
  native_token: string;
  gas_price_gwei: number | null;
  est_transfer_eth: number | null;
  note: string | null;
  error: string | null;
}> {
  const chain = GAS_CHAINS[chainKey];
  try {
    const res = await fetch(chain.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json() as { result?: string };
    if (!data.result) throw new Error("No result");
    const weiBigInt = BigInt(data.result);
    const gwei = Number(weiBigInt) / 1e9;
    const estTransferEth = (gwei * 21000) / 1e9; // 21000 gas units * price
    return {
      chain: chain.name,
      chain_id: chain.chainId,
      native_token: chain.nativeToken,
      gas_price_gwei: parseFloat(gwei.toFixed(4)),
      est_transfer_eth: parseFloat(estTransferEth.toFixed(8)),
      note: `~${estTransferEth.toFixed(6)} ${chain.nativeToken} per basic transfer (21000 gas)`,
      error: null,
    };
  } catch {
    return {
      chain: chain.name,
      chain_id: chain.chainId,
      native_token: chain.nativeToken,
      gas_price_gwei: null,
      est_transfer_eth: null,
      note: null,
      error: "unavailable",
    };
  }
}

// ─── GET /gas — current gas prices across EVM chains ───

chains.get("/gas", async (c) => {
  c.header("Cache-Control", "public, max-age=15"); // 15s CDN cache — gas changes fast

  const results = await Promise.allSettled(
    Object.keys(GAS_CHAINS).map((key) => fetchGasPrice(key))
  );

  const gas = results.map((r) => r.status === "fulfilled" ? r.value : null).filter(Boolean);

  return c.json({
    gas_prices: gas,
    timestamp: new Date().toISOString(),
    source: "Direct RPC (eth_gasPrice)",
    note: "Solana and Bitcoin use different fee models. Solana: ~0.000005 SOL per tx. Bitcoin: use mempool.space/api/v1/fees/recommended",
    solana: { chain: "Solana", model: "per-signature fee", typical_lamports: 5000, typical_sol: 0.000005 },
    bitcoin: { chain: "Bitcoin", model: "sat/vByte", check: "https://mempool.space/api/v1/fees/recommended" },
  });
});

// ─── GET /gas/:chain — gas price for a specific chain ───

chains.get("/gas/:chain", async (c) => {
  const chainKey = c.req.param("chain").toLowerCase();
  if (!GAS_CHAINS[chainKey]) {
    return c.json({
      error: "unsupported_chain",
      message: `Supported chains: ${Object.keys(GAS_CHAINS).join(", ")}`,
    }, 400);
  }
  c.header("Cache-Control", "public, max-age=15");
  const result = await fetchGasPrice(chainKey);
  return c.json(result);
});

// GET / — supported chains
chains.get("/", (c) => {
  return c.json({
    wallet_chains: Object.entries(SUPPORTED_CHAINS).map(([key, chain]) => ({
      id: key,
      name: chain.name,
      chain_id: chain.chainId,
      native_token: chain.nativeToken,
      explorer: chain.explorer,
    })),
    swap_chains: Object.keys(WAGYU_CHAIN_IDS).map((name) => ({
      id: name,
      wagyu_chain_id: WAGYU_CHAIN_IDS[name],
    })),
    note: "Wallet operations (create, balance, send) support wallet_chains. Swaps support all swap_chains via Wagyu.",
  });
});

// GET /tokens — well-known ERC-20 tokens on Base and Ethereum
chains.get("/tokens", (c) => {
  return c.json({
    note: "Pass the 'token' contract address to POST /v1/wallet/send or /v1/wallet/multi-send to send ERC-20 tokens",
    tokens: {
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
    },
    usage_example: {
      send_usdc_on_base: {
        endpoint: "POST /v1/wallet/send",
        body: {
          chain: "base",
          to: "0xRecipientAddress",
          amount: "10",
          private_key: "0xYourPrivateKey",
          token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
        note: "amount is in token units (10 = 10 USDC). Decimals handled automatically.",
      },
    },
  });
});

export default chains;
