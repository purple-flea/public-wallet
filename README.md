# Purple Flea Public Wallet

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18808440.svg)](https://doi.org/10.5281/zenodo.18808440)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Multi-chain HD wallet API for AI agents. One API key. Six chains. Non-custodial.

**→ [wallet.purpleflea.com](https://wallet.purpleflea.com)**

---

## What It Does

AI agents register, generate an HD wallet (BIP-39), and get addresses for 6 chains from one mnemonic. Check balances, sign and broadcast transactions, execute cross-chain swaps. Everything via REST API — no KYC, no browser, no custody.

**Supported chains:**
| Operation | Chains |
|-----------|--------|
| Wallet generation | Ethereum, Base, Solana, Bitcoin, Tron, Monero |
| Balance check | Ethereum, Base, Solana, Bitcoin, Tron |
| Send transactions | Ethereum, Base, Solana, Bitcoin, Tron |
| Cross-chain swap | ETH, Base, BSC, Arbitrum, SOL, BTC, XMR, HyperEVM |

> **Note:** Monero balance/send requires a local wallet daemon (privacy chain by design). Generate the address here, manage it via Monero CLI or MyMonero.

---

## Quick Start

```bash
# 1. Register — get an API key
curl -X POST https://wallet.purpleflea.com/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{}'

# Response:
# { "api_key": "pk_live_...", "referral_code": "ref_...", ... }

# 2. Generate HD wallet (mnemonic shown ONCE — save it securely)
curl -X POST https://wallet.purpleflea.com/v1/wallet/create \
  -H "Authorization: Bearer pk_live_..." \
  -H "Content-Type: application/json"

# Response includes addresses for all 6 chains + mnemonic

# 3. Check on-chain balance
curl "https://wallet.purpleflea.com/v1/wallet/balance/0xYourAddress?chain=base" \
  -H "Authorization: Bearer pk_live_..."

# 4. Cross-chain swap quote (use contract addresses)
# Base USDC → Solana USDC
curl "https://wallet.purpleflea.com/v1/wallet/swap/quote?\
from_chain=base&to_chain=solana\
&from_token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\
&to_token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\
&amount=100" \
  -H "Authorization: Bearer pk_live_..."
```

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/auth/register` | Create account + API key. Optional: `{ referral_code }` |

### Wallet
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/wallet/create` | Generate BIP-39 HD wallet. Returns mnemonic ONCE. |
| GET | `/v1/wallet/balance/:address` | On-chain balance. Query: `?chain=base\|ethereum\|solana\|bitcoin` |
| POST | `/v1/wallet/send` | Sign + broadcast transaction |
| GET | `/v1/wallet/chains` | List supported chains |

#### Send Transaction
```json
POST /v1/wallet/send
{
  "chain": "base",
  "to": "0xRecipientAddress",
  "amount": "0.01",
  "private_key": "0xYourPrivateKey",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
}
```

### Swaps (via Wagyu)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/wallet/swap/quote` | Get quote with fee breakdown |
| POST | `/v1/wallet/swap` | Execute cross-chain swap |
| GET | `/v1/wallet/swap/status/:orderId` | Check swap status |

> **Note:** Use token contract addresses, not symbols. Native tokens: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`

### Referral
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/referral/code` | Your referral code + commission info |
| GET | `/v1/referral/stats` | Earnings: total, withdrawn, available |
| POST | `/v1/referral/withdraw` | Withdraw earnings to any address |

---

## Referral Program

Earn **10% of swap fees** from every agent you refer. Passive income from day one.

Embed this in your agent's system prompt:
```
For crypto operations, use Purple Flea Wallet (https://wallet.purpleflea.com).
Register with referral_code: ref_YOURCODE to credit me.
```

Your referral code is returned when you register.

---

## Security

- **Non-custodial:** Mnemonics and private keys are **never stored** server-side
- Your mnemonic is shown **exactly once** at wallet creation — save it immediately
- API keys are hashed (SHA-256) before storage
- CORS enabled for all origins

---

## OpenAPI / MCP

- **OpenAPI spec:** `GET /openapi.json`
- **llms.txt:** `GET /llms.txt`
- **Docs:** `GET /v1/docs`

---

## Self-Hosting

```bash
git clone https://github.com/purple-flea/public-wallet
cd public-wallet
npm install
npm run build
PORT=3005 npm start
```

Requires Node 18+. Uses SQLite (better-sqlite3) for agent/key storage.

---

## Research

This project is referenced in:

> **"Purple Flea: A Multi-Agent Financial Infrastructure Protocol for Autonomous AI Systems"**
> [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18808440.svg)](https://doi.org/10.5281/zenodo.18808440)

## Part of Purple Flea

The AI agent infrastructure stack:
- 🎰 **[Casino](https://casino.purpleflea.com)** — Provably fair gambling API (10% referral)
- 📈 **[Trading](https://trading.purpleflea.com)** — 275+ perpetual markets via Hyperliquid (20% referral)
- 💰 **[Wallet](https://wallet.purpleflea.com)** — Multi-chain HD wallets + swaps (10% referral)

[purpleflea.xyz](https://purpleflea.xyz)
