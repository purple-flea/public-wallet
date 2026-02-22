/**
 * Wagyu.xyz swap integration for public wallet API
 * Cross-chain swaps with 0.5% integrator fee (our revenue)
 */

import { WAGYU_CHAIN_IDS, NATIVE_TOKENS, TOKEN_ADDRESSES } from "../chains/config.js";

const WAGYU_API = "https://api.wagyu.xyz";
const API_KEY = process.env.WAGYU_API_KEY || "";

export const INTEGRATOR_FEE_BPS = 50; // 0.5% = 50 basis points

interface WagyuQuote {
  fromAmount: string;
  fromAmountUsd: string;
  fromSymbol: string;
  toAmount: string;
  toAmountUsd: string;
  toSymbol: string;
  estimatedTime: number;
  minReceived: string;
  integratorFee?: string;
}

interface WagyuOrder {
  orderId: string;
  depositAddress: string;
  depositChain: string;
  depositChainId: number;
  depositToken: string;
  depositTokenSymbol: string;
  depositAmount: string;
  toAddress: string;
  expectedOutput: string;
  expiresAt: string;
  status: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-KEY"] = API_KEY;
  return h;
}

function resolveToken(chain: string, token: string): string {
  if (token.startsWith("0x")) return token;
  const native = NATIVE_TOKENS[chain];
  if (native && token.toUpperCase() === native.toUpperCase()) return token;
  const chainTokens = TOKEN_ADDRESSES[chain];
  if (chainTokens && chainTokens[token.toUpperCase()]) {
    return chainTokens[token.toUpperCase()];
  }
  return token;
}

export async function getQuote(
  fromChain: string,
  toChain: string,
  fromToken: string,
  toToken: string,
  fromAmount: string,
): Promise<WagyuQuote> {
  const fromChainId = WAGYU_CHAIN_IDS[fromChain];
  const toChainId = WAGYU_CHAIN_IDS[toChain];

  if (fromChainId === undefined) throw new Error(`Unsupported source chain: ${fromChain}`);
  if (toChainId === undefined) throw new Error(`Unsupported destination chain: ${toChain}`);

  const res = await fetch(`${WAGYU_API}/v1/quote`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      fromChainId,
      toChainId,
      fromToken: resolveToken(fromChain, fromToken),
      toToken: resolveToken(toChain, toToken),
      fromAmount,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Wagyu quote failed: ${err}`);
  }

  return await res.json() as WagyuQuote;
}

export async function createOrder(
  fromChain: string,
  toChain: string,
  fromToken: string,
  toToken: string,
  fromAmount: string,
  toAddress: string,
): Promise<WagyuOrder> {
  const fromChainId = WAGYU_CHAIN_IDS[fromChain];
  const toChainId = WAGYU_CHAIN_IDS[toChain];

  const res = await fetch(`${WAGYU_API}/v1/order`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      fromChainId,
      toChainId,
      fromToken: resolveToken(fromChain, fromToken),
      toToken: resolveToken(toChain, toToken),
      fromAmount,
      toAddress,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Wagyu order failed: ${err}`);
  }

  return await res.json() as WagyuOrder;
}

export async function getOrderStatus(orderId: string): Promise<any> {
  const res = await fetch(`${WAGYU_API}/v1/order/${orderId}`, { headers: headers() });
  if (!res.ok) throw new Error("Wagyu status check failed");
  return await res.json();
}

export async function getWagyuChains(): Promise<any[]> {
  const res = await fetch(`${WAGYU_API}/v1/chains`, { headers: headers() });
  const data = await res.json() as any;
  return data.chains;
}

/** Calculate our 0.5% integrator fee from a USD amount */
export function calculateFee(amountUsd: number): { fee: number; referralShare: number; netRevenue: number } {
  const fee = amountUsd * (INTEGRATOR_FEE_BPS / 10000);
  const referralShare = fee * 0.10; // 10% of fee to referrer
  return { fee, referralShare, netRevenue: fee - referralShare };
}
