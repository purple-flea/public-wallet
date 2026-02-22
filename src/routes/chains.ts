import { Hono } from "hono";
import { SUPPORTED_CHAINS, WAGYU_CHAIN_IDS } from "../chains/config.js";

const chains = new Hono();

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

export default chains;
