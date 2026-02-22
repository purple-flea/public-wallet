export const SUPPORTED_CHAINS = {
  ethereum: {
    name: "Ethereum",
    chainId: 1,
    nativeToken: "ETH",
    rpcUrl: "https://eth.llamarpc.com",
    explorer: "https://etherscan.io",
    derivationPath: "m/44'/60'/0'/0/0",
  },
  base: {
    name: "Base",
    chainId: 8453,
    nativeToken: "ETH",
    rpcUrl: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    derivationPath: "m/44'/60'/0'/0/0",
  },
  solana: {
    name: "Solana",
    chainId: 1151111081099710,
    nativeToken: "SOL",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorer: "https://solscan.io",
    derivationPath: "m/44'/501'/0'/0'",
  },
  bitcoin: {
    name: "Bitcoin",
    chainId: 20000000000001,
    nativeToken: "BTC",
    rpcUrl: "",
    explorer: "https://mempool.space",
    derivationPath: "m/84'/0'/0'/0/0",
  },
} as const;

export type ChainName = keyof typeof SUPPORTED_CHAINS;

// Wagyu chain IDs for swap integration
export const WAGYU_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  hyperevm: 999,
  base: 8453,
  arbitrum: 42161,
  solana: 1151111081099710,
  bitcoin: 20000000000001,
  monero: 0,
};

export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  ethereum: {
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  arbitrum: {
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  },
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  bsc: {
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
};

export const NATIVE_TOKENS: Record<string, string> = {
  ethereum: "ETH",
  bsc: "BNB",
  base: "ETH",
  arbitrum: "ETH",
  solana: "SOL",
  bitcoin: "BTC",
  monero: "XMR",
};
