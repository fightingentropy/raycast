#!/bin/zsh
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Forex
# @raycast.mode inline
# @raycast.refreshTime 1m
# Optional parameters:
# @raycast.packageName Finance
# @raycast.icon 💱
# Documentation:
# @raycast.description Show current GBP/USD, EUR/USD and USD/JPY exchange rates.

set -euo pipefail

assets=("$@")
if [ ${#assets[@]} -eq 0 ] || [[ -z "${assets[*]//[[:space:]]/}" ]]; then
  assets=("GBPUSD" "EURUSD" "USDJPY")
fi

orderbook_endpoint="https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails"
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse zklighter responses."
  exit 1
fi

orderbook_response=$(curl -sS --fail "$orderbook_endpoint")

rates=()
for asset in "${assets[@]}"; do
  normalized_asset="${asset//[$' \t\r\n']/}"
  normalized_asset="${normalized_asset:u}"

  if [ -z "$normalized_asset" ]; then
    continue
  fi

  lookup_symbol="$normalized_asset"
  invert_rate=false
  case "$normalized_asset" in
    "JPYUSD") lookup_symbol="USDJPY"; invert_rate=true ;;
  esac

  last_trade_price=$(echo "$orderbook_response" | jq -r --arg sym "$lookup_symbol" \
    '.order_book_details[]? | select(.symbol == $sym) | .last_trade_price' | head -n 1)
  daily_low=$(echo "$orderbook_response" | jq -r --arg sym "$lookup_symbol" \
    '.order_book_details[]? | select(.symbol == $sym) | .daily_price_low' | head -n 1)
  daily_high=$(echo "$orderbook_response" | jq -r --arg sym "$lookup_symbol" \
    '.order_book_details[]? | select(.symbol == $sym) | .daily_price_high' | head -n 1)

  price_source="$last_trade_price"
  if [ -z "$price_source" ] || [ "$price_source" = "null" ] || [ "$price_source" = "0" ] || [ "$price_source" = "0.0" ]; then
    if [ -n "$daily_low" ] && [ "$daily_low" != "null" ] && [ -n "$daily_high" ] && [ "$daily_high" != "null" ]; then
      price_source=$(awk -v low="$daily_low" -v high="$daily_high" 'BEGIN { printf "%.8f", (low + high) / 2 }')
    else
      continue
    fi
  fi

  if $invert_rate; then
    if [ "$price_source" = "0" ] || [ "$price_source" = "0.0" ]; then
      continue
    fi
    mid_price=$(awk -v price="$price_source" 'BEGIN { printf "%.4f", 1 / price }')
  else
    mid_price=$(printf "%.4f" "$price_source")
  fi

  # Format asset name for display
  case "$normalized_asset" in
    "GBPUSD") display_name="GBP/USD" ;;
    "EURUSD") display_name="EUR/USD" ;;
    "JPYUSD") display_name="JPY/USD" ;;
    "USDJPY") display_name="USD/JPY" ;;
    *) display_name="$normalized_asset" ;;
  esac

  rates+=("$display_name: $mid_price")
done

echo "${rates[*]}"
