#!/bin/zsh
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Crypto
# @raycast.mode inline
# @raycast.refreshTime 1m
# Optional parameters:
# @raycast.packageName Finance
# @raycast.icon 💱
# Documentation:
# @raycast.description Show BTC, ETH, and HYPE prices with 24h change from Hyperliquid.

set -euo pipefail

API_URL="https://api.hyperliquid.xyz/info"
PAYLOAD='{"type":"metaAndAssetCtxs"}'

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse Hyperliquid responses."
  exit 1
fi

# Grab market data once to avoid multiple network calls.
market_data=$(curl -sf -X POST "$API_URL" -H "Content-Type: application/json" -d "$PAYLOAD") || market_data=""
if [[ -z "$market_data" ]]; then
  echo "Unable to fetch prices."
  exit 1
fi

fetch_coin_data() {
  local coin=$1
  local result
  result=$(echo "$market_data" | jq -r --arg COIN "$coin" '
    . as $root |
    ($root[0].universe | to_entries[] | select(.value.name==$COIN).key) as $idx |
    if $idx == null then
      "N/A\tN/A"
    else
      ($root[1][$idx]) as $ctx |
      ($ctx.midPx // $ctx.markPx // $ctx.oraclePx) as $price |
      ($ctx.prevDayPx // empty) as $prev |
      if $price == null then
        "N/A\tN/A"
      else
        ($price|tonumber) as $p |
        if $prev == null or ($prev|tonumber) == 0 then
          "\($p)\tN/A"
        else
          ($prev|tonumber) as $prevNum |
          "\($p)\t\(((($p - $prevNum)/$prevNum)*100))"
        end
      end
    end
  ')

  IFS=$'\t' read -r price change <<< "$result"

  if [[ "$price" != "N/A" ]]; then
    price=$(printf "%.2f" "$price")
  fi

  if [[ "$change" != "N/A" ]]; then
    change=$(printf "%+.2f" "$change")
  fi

  echo "$price:$change"
}

btc_data=$(fetch_coin_data "BTC")
eth_data=$(fetch_coin_data "ETH")
hype_data=$(fetch_coin_data "HYPE")

IFS=':' read -r btc_price btc_change <<< "$btc_data"
IFS=':' read -r eth_price eth_change <<< "$eth_data"
IFS=':' read -r hype_price hype_change <<< "$hype_data"

echo "BTC: $btc_price (${btc_change}%) | ETH: $eth_price (${eth_change}%) | HYPE: $hype_price (${hype_change}%)"
