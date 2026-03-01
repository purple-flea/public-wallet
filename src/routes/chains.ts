import { Hono } from "hono";
import { SUPPORTED_CHAINS, WAGYU_CHAIN_IDS } from "../chains/config.js";

const chains = new Hono();

// EVM RPC endpoints for gas price checks
const GAS_CHAINS: Record<string, { name: string; rpc: string; nativeToken: string; chainId: number }> = {
  ethereum: { name: "Ethereum", rpc: "https://ethereum.publicnode.com", nativeToken: "ETH", chainId: 1 },
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

// GET /chains/yield — live USDC yield rates across DeFi protocols (via DeFi Llama)
chains.get("/yield", async (c) => {
  c.header("Cache-Control", "public, max-age=300"); // 5min cache

  // DeFi Llama pools API — filter for USDC on Base/Ethereum
  // Pool IDs for well-known USDC lending markets
  const KNOWN_POOLS: Array<{
    id: string;
    protocol: string;
    chain: string;
    token: string;
    type: string;
    risk: string;
    tvl_floor_usd: number; // min TVL to consider it legitimate
  }> = [
    { id: "43641cf5-a92e-416b-bce9-27113d3c0db6", protocol: "Maple Finance", chain: "Ethereum", token: "USDC", type: "lending", risk: "medium", tvl_floor_usd: 1_000_000 },
    { id: "c5c74dd1-995c-4445-9d84-3e710bad7d52", protocol: "Spark (DAI Savings)", chain: "Ethereum", token: "USDC", type: "savings", risk: "low", tvl_floor_usd: 1_000_000 },
    { id: "7372edda-f07f-4598-83e5-4edec48c4039", protocol: "Fluid Lending", chain: "Base", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 100_000 },
    { id: "4438dabc-7f0c-430b-8136-2722711ae663", protocol: "Fluid Lending", chain: "Ethereum", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 1_000_000 },
    { id: "7e0661bf-8cf3-45e6-9424-31916d4c7b84", protocol: "Aave V3", chain: "Base", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 1_000_000 },
    { id: "0c8567f8-ba5b-41ad-80de-00a71895eb19", protocol: "Compound V3", chain: "Base", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 500_000 },
    { id: "aa70268e-4b52-42bf-a116-608b370f9501", protocol: "Aave V3", chain: "Ethereum", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 1_000_000 },
    { id: "7da72d09-56ca-4ec5-a45f-59114353e487", protocol: "Compound V3", chain: "Ethereum", token: "USDC", type: "lending", risk: "low", tvl_floor_usd: 1_000_000 },
  ];

  try {
    // Fetch all pools from DeFi Llama (returns all, we filter by our known IDs)
    const res = await fetch("https://yields.llama.fi/pools", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`DeFi Llama returned ${res.status}`);

    const data = await res.json() as { data: Array<{
      pool: string;
      apy: number | null;
      apyBase: number | null;
      apyReward: number | null;
      tvlUsd: number | null;
      symbol: string;
      project: string;
      chain: string;
    }> };

    const poolMap = new Map<string, typeof data.data[0]>();
    for (const pool of data.data) {
      poolMap.set(pool.pool, pool);
    }

    // Build results from known pools
    const yields = KNOWN_POOLS.map(known => {
      const live = poolMap.get(known.id);
      if (!live || (live.tvlUsd ?? 0) < known.tvl_floor_usd) {
        return { ...known, apy: null, apy_base: null, apy_reward: null, tvl_usd: live?.tvlUsd ?? null, status: "data_unavailable" };
      }
      return {
        protocol: known.protocol,
        chain: known.chain,
        token: known.token,
        type: known.type,
        risk: known.risk,
        apy: live.apy !== null ? parseFloat(live.apy.toFixed(2)) : null,
        apy_base: live.apyBase !== null ? parseFloat(live.apyBase.toFixed(2)) : null,
        apy_reward: live.apyReward !== null ? parseFloat(live.apyReward.toFixed(2)) : null,
        tvl_usd: live.tvlUsd !== null ? Math.round(live.tvlUsd) : null,
        status: "live",
      };
    }).filter(y => y.status === "live");

    // Sort by APY desc
    yields.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));

    const bestYield = yields[0] ?? null;
    const avgApy = yields.length > 0
      ? parseFloat((yields.reduce((s, y) => s + (y.apy ?? 0), 0) / yields.length).toFixed(2))
      : null;

    return c.json({
      as_of: new Date().toISOString(),
      token: "USDC",
      best_apy: bestYield ? {
        protocol: bestYield.protocol,
        chain: bestYield.chain,
        apy_pct: bestYield.apy,
        annual_yield_on_1000: bestYield.apy !== null ? parseFloat(((bestYield.apy / 100) * 1000).toFixed(2)) : null,
      } : null,
      average_apy_pct: avgApy,
      yields,
      how_to_earn: {
        simplest: "Deposit USDC into Coinbase, which pays ~5% APY natively (cbUSDC via Morpho on Base)",
        on_chain: [
          "1. Bridge USDC to Base via https://bridge.base.org",
          "2. Connect wallet to app.aave.com or moonwell.fi",
          "3. Supply USDC — earn interest instantly",
          "4. Withdraw any time with no lock-up",
        ],
        note: "All listed protocols are non-custodial. You keep custody of funds. Smart contract risk applies.",
      },
      comparison: {
        traditional_savings: "~4.5% (HYSA, 2026)",
        treasury_yield: "~4.3% (3-month T-bill)",
        best_defi_usdc: bestYield?.apy ? `${bestYield.apy}% on ${bestYield.protocol} (${bestYield.chain})` : "N/A",
        note: "DeFi rates fluctuate with utilization. Higher rates = higher demand for borrowing.",
      },
      source: "DeFi Llama yield API (yields.llama.fi)",
      disclaimer: "Not financial advice. Smart contract risk. Rates change continuously.",
    });
  } catch (err: any) {
    // Fallback: return static approximate rates
    return c.json({
      as_of: new Date().toISOString(),
      token: "USDC",
      note: "Live rates unavailable — showing approximate rates as of Feb 2026",
      error: err.message,
      approximate_yields: [
        { protocol: "Aave V3", chain: "Base", apy_approx_pct: 5.5, risk: "low" },
        { protocol: "Aave V3", chain: "Ethereum", apy_approx_pct: 4.8, risk: "low" },
        { protocol: "Compound V3", chain: "Base", apy_approx_pct: 5.2, risk: "low" },
        { protocol: "Moonwell", chain: "Base", apy_approx_pct: 6.0, risk: "low" },
      ],
      how_to_check: "Retry in a few minutes or visit https://defillama.com/yields?token=USDC",
    });
  }
});

// ─── GET /estimate-cost — USD cost for common transaction types ───
// tx_type: transfer | erc20_transfer | swap | nft_mint | contract_deploy | approve
// chain: ethereum | base | arbitrum | bsc

const GAS_UNITS: Record<string, number> = {
  transfer: 21_000,
  erc20_transfer: 65_000,
  approve: 46_000,
  swap: 150_000,       // typical DEX swap (Uniswap V3)
  nft_mint: 200_000,   // typical ERC-721 mint
  contract_deploy: 600_000, // average contract deployment
};

chains.get("/estimate-cost", async (c) => {
  const txType = (c.req.query("tx_type") ?? "transfer").toLowerCase();
  const chainFilter = c.req.query("chain")?.toLowerCase();
  c.header("Cache-Control", "public, max-age=30");

  const validTypes = Object.keys(GAS_UNITS);
  if (!validTypes.includes(txType)) {
    return c.json({
      error: "invalid_tx_type",
      message: `tx_type must be one of: ${validTypes.join(", ")}`,
      example: "GET /v1/chains/estimate-cost?tx_type=swap&chain=base",
    }, 400);
  }

  const gasUnits = GAS_UNITS[txType];

  // Fetch ETH/BNB prices from CoinGecko
  let ethUsd = 2400; // fallback
  let bnbUsd = 380;  // fallback
  try {
    const priceRes = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000) }
    );
    const priceData = await priceRes.json() as any;
    if (priceData?.ethereum?.usd) ethUsd = priceData.ethereum.usd;
    if (priceData?.binancecoin?.usd) bnbUsd = priceData.binancecoin.usd;
  } catch {
    // use fallbacks
  }

  // Fetch gas prices for requested chains
  const chainsToCheck = chainFilter
    ? (GAS_CHAINS[chainFilter] ? [chainFilter] : [])
    : Object.keys(GAS_CHAINS);

  if (chainFilter && chainsToCheck.length === 0) {
    return c.json({
      error: "unsupported_chain",
      message: `Supported chains: ${Object.keys(GAS_CHAINS).join(", ")}`,
    }, 400);
  }

  const gasResults = await Promise.allSettled(chainsToCheck.map(fetchGasPrice));

  const estimates = gasResults
    .map((r, i) => {
      if (r.status !== "fulfilled" || !r.value.gas_price_gwei) return null;
      const gas = r.value;
      const chainKey = chainsToCheck[i];
      const nativePrice = chainKey === "bsc" ? bnbUsd : ethUsd;
      const gasGwei = gas.gas_price_gwei as number;
      const costNative = (gasGwei * gasUnits) / 1e9;
      const costUsd = costNative * nativePrice;

      return {
        chain: gas.chain,
        chain_id: gas.chain_id,
        native_token: gas.native_token,
        gas_price_gwei: gas.gas_price_gwei,
        gas_units: gasUnits,
        cost_native: parseFloat(costNative.toFixed(8)),
        cost_usd: parseFloat(costUsd.toFixed(4)),
        native_price_usd: nativePrice,
        speed_estimate: gasGwei < 2 ? "fast (<15s)" : gasGwei < 10 ? "normal (~30s)" : "congested",
      };
    })
    .filter(Boolean);

  // Sort by cost_usd asc
  estimates.sort((a, b) => (a!.cost_usd ?? 999) - (b!.cost_usd ?? 999));

  const cheapest = estimates[0];

  return c.json({
    tx_type: txType,
    gas_units: gasUnits,
    estimates,
    cheapest_chain: cheapest ? {
      chain: cheapest.chain,
      cost_usd: cheapest.cost_usd,
      tip: cheapest.cost_usd < 0.01
        ? `${cheapest.chain} is nearly free for this operation`
        : `${cheapest.chain} costs ~$${cheapest.cost_usd.toFixed(3)} for this operation`,
    } : null,
    tx_type_guide: {
      transfer: "Send native token (ETH/BNB) to another address",
      erc20_transfer: "Send USDC, USDT, or any ERC-20 token",
      approve: "Allow a contract (e.g. DEX) to spend your tokens",
      swap: "Swap tokens on Uniswap V3 or similar DEX",
      nft_mint: "Mint a new NFT (ERC-721)",
      contract_deploy: "Deploy a new smart contract",
    },
    prices_used: { eth_usd: ethUsd, bnb_usd: bnbUsd },
    note: "Gas estimates are approximate. Actual cost depends on network congestion and contract complexity.",
    updated_at: new Date().toISOString(),
  });
});

// ─── GET /send-preview — estimate actual gas fee for a specific send transaction ───

chains.get("/send-preview", async (c) => {
  const chain = c.req.query("chain") ?? "";
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const amount = c.req.query("amount") ?? "";
  const token = c.req.query("token") ?? ""; // optional ERC-20 contract

  if (!chain || !GAS_CHAINS[chain]) {
    return c.json({
      error: "invalid_chain",
      message: `chain must be one of: ${Object.keys(GAS_CHAINS).join(", ")}`,
      note: "For Bitcoin use mempool.space/api/v1/fees/recommended. For Solana, fee is ~0.000005 SOL.",
      example: "GET /v1/wallet/chains/send-preview?chain=base&from=0x1234...&to=0x5678...&amount=1.5",
    }, 400);
  }
  if (!from || !from.startsWith("0x")) {
    return c.json({ error: "invalid_from", message: "from must be a valid EVM address (0x...)" }, 400);
  }
  if (!to || !to.startsWith("0x")) {
    return c.json({ error: "invalid_to", message: "to must be a valid EVM address (0x...)" }, 400);
  }

  const chainConfig = GAS_CHAINS[chain];
  const rpc = chainConfig.rpc;

  // Fetch gas price and native token price in parallel
  const [gasData, priceData] = await Promise.allSettled([
    fetchGasPrice(chain),
    fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chain === "bsc" ? "binancecoin" : "ethereum"}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(4000) }
    ).then(r => r.json() as Promise<any>).catch(() => null),
  ]);

  const gas = gasData.status === "fulfilled" ? gasData.value : null;
  const priceJson = priceData.status === "fulfilled" ? priceData.value : null;
  const nativePriceUsd: number = chain === "bsc"
    ? (priceJson?.binancecoin?.usd ?? 380)
    : (priceJson?.ethereum?.usd ?? 2400);

  // Build the tx object for eth_estimateGas
  let txData: string | undefined;
  let estimatedGasUnits = 21000; // default: native transfer

  if (token && token.startsWith("0x")) {
    // ERC-20 transfer: encode transfer(address,uint256)
    // keccak256("transfer(address,uint256)") = 0xa9059cbb
    const toClean = to.toLowerCase().replace("0x", "").padStart(64, "0");
    // We can't know exact amount without decimals, use placeholder uint256
    const amountHex = "0000000000000000000000000000000000000000000000000de0b6b3a7640000"; // 1 token (18 dec placeholder)
    txData = "0xa9059cbb" + toClean + amountHex;
    estimatedGasUnits = 65000; // typical ERC-20 transfer
  }

  // Try eth_estimateGas for more precise estimate
  let preciseGasUnits: number | null = null;
  try {
    const txObj: Record<string, string> = { from, to: token || to };
    if (txData) txObj.data = txData;
    if (!txData && amount) {
      // Convert amount to wei for native transfer
      const amountWei = BigInt(Math.floor(parseFloat(amount) * 1e18)).toString(16);
      txObj.value = "0x" + amountWei;
    }

    const estimateRes = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [txObj, "latest"] }),
      signal: AbortSignal.timeout(6000),
    });
    const estimateData = await estimateRes.json() as any;
    if (estimateData.result) {
      preciseGasUnits = parseInt(estimateData.result, 16);
    }
  } catch {
    // Fall back to typical gas units
  }

  const finalGasUnits = preciseGasUnits ?? estimatedGasUnits;
  const gasGwei = gas?.gas_price_gwei ?? null;

  if (!gasGwei) {
    return c.json({
      error: "gas_fetch_failed",
      message: "Could not fetch current gas price",
      chain,
    }, 502);
  }

  // Calculate fee
  const feeNative = (gasGwei * finalGasUnits) / 1e9;
  const feeUsd = feeNative * nativePriceUsd;

  // Add 20% buffer for fee recommendation
  const recommendedGwei = gasGwei * 1.2;
  const recommendedFeeNative = (recommendedGwei * finalGasUnits) / 1e9;
  const recommendedFeeUsd = recommendedFeeNative * nativePriceUsd;

  return c.json({
    chain,
    from,
    to,
    amount: amount || null,
    token: token || null,
    tx_type: token ? "erc20_transfer" : "native_transfer",
    gas: {
      current_gas_price_gwei: Math.round(gasGwei * 10000) / 10000,
      gas_units: finalGasUnits,
      estimate_source: preciseGasUnits ? "eth_estimateGas (precise)" : "typical gas units (estimated)",
    },
    fee: {
      native_amount: Math.round(feeNative * 1e8) / 1e8,
      native_token: chainConfig.nativeToken,
      usd_amount: Math.round(feeUsd * 10000) / 10000,
    },
    recommended_fee: {
      note: "+20% buffer for faster confirmation",
      gwei: Math.round(recommendedGwei * 10000) / 10000,
      native_amount: Math.round(recommendedFeeNative * 1e8) / 1e8,
      usd_amount: Math.round(recommendedFeeUsd * 10000) / 10000,
    },
    native_token_price_usd: nativePriceUsd,
    timestamp: new Date().toISOString(),
  });
});

export default chains;
