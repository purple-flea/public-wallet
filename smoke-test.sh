#!/bin/bash
# Wallet Smoke Test — checks all public endpoints return 200
# Usage: ./wallet-smoke-test.sh [BASE_URL]
# Default BASE_URL: http://localhost:3005

BASE_URL="${1:-http://localhost:3005}"
PASS=0
FAIL=0
ERRORS=()

check() {
  local method="$1"
  local path="$2"
  local desc="$3"
  local body="$4"
  local expected="${5:-200}"

  if [ -n "$body" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${BASE_URL}${path}")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "${BASE_URL}${path}")
  fi

  if [ "$status" = "$expected" ]; then
    echo "  ✓ $method $path ($desc) → $status"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $method $path ($desc) → $status (expected $expected)"
    FAIL=$((FAIL + 1))
    ERRORS+=("$method $path: got $status, expected $expected")
  fi
}

echo "=== Wallet Smoke Test ==="
echo "Target: $BASE_URL"
echo ""

echo "--- Public endpoints ---"
check GET /health "health check"
check GET /v1/gossip "gossip"
check GET /v1/public-stats "public stats"
check GET /v1/wallet/chains "supported chains"
check GET /v1/wallet/chains/tokens "ERC-20 token list"
check GET /changelog "changelog"
check GET /robots.txt "robots.txt"
check GET /sitemap.xml "sitemap"
check GET /.well-known/agent.json "agent.json"
check GET /.well-known/purpleflea.json "purpleflea.json"
check GET /network "network"
check GET /openapi.json "openapi spec"
check GET /llms.txt "llms.txt"
check GET /favicon.ico "favicon" "" 204
check GET /ping "ping"
check GET "/v1/price?symbol=BTC" "BTC price (public)"
check GET "/v1/price?symbol=ETH" "ETH price (public)"
check GET /v1/gas "gas price oracle"
check GET "/v1/portfolio?address=0x742d35Cc6634C0532925a3b8D4e86F91d5C9C9cB" "portfolio aggregator"
check GET "/v1/swap/estimate?from=ETH&to=USDC&amount=1&chain=ethereum" "swap estimate"
check GET "/v1/swap/routes?from=ETH&to=USDC&amount=1&chain=ethereum" "swap routes"
check GET /v1/defi/rates "defi lending rates"

echo ""
echo "--- Auth endpoints return 401 without token ---"
check POST /v1/wallet/create "wallet create (no auth)" '{}' 401
check GET /v1/wallet/balance/0x1234?chain=ethereum "balance (no auth)" "" 401
check POST /v1/wallet/swap "swap (no auth)" '{}' 401

echo ""
echo "--- 404 handling ---"
check GET /nonexistent-path "404 handler" "" 404

echo ""
echo "==========================="
echo "Results: $PASS passed, $FAIL failed"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "FAILURES:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
else
  echo "All checks passed!"
  exit 0
fi
