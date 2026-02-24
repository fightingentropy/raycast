#!/bin/zsh
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Commodities
# @raycast.mode inline
# @raycast.refreshTime 1m
# Optional parameters:
# @raycast.packageName Finance
# @raycast.icon 🛢️
# Documentation:
# @raycast.description Show current Gold, Silver, and Crude prices from the xyz HIP-3 markets on Hyperliquid.

set -euo pipefail

assets=("$@")
if [ ${#assets[@]} -eq 0 ] || [[ -z "${assets[*]//[[:space:]]/}" ]]; then
  assets=("xyz:GOLD" "xyz:SILVER" "xyz:CL")
fi

API_URL="https://api.hyperliquid.xyz/info"
PAYLOAD='{"type":"metaAndAssetCtxs","dex":"xyz"}'

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse Hyperliquid responses."
  exit 1
fi

market_data=$(curl -sf -X POST "$API_URL" -H "Content-Type: application/json" -d "$PAYLOAD") || market_data=""
if [[ -z "$market_data" ]]; then
  echo "Unable to fetch prices."
  exit 1
fi

fetch_asset_data() {
  local asset=$1
  local result

  result=$(echo "$market_data" | jq -r --arg ASSET "$asset" '
    . as $root |
    ($root[0].universe | to_entries[]
      | select(.value.name==$ASSET).key) as $idx |
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

quotes=()
for asset in "${assets[@]}"; do
  normalized_asset="${asset//[$' \t\r\n']/}"
  if [[ -z "$normalized_asset" ]]; then
    continue
  fi

  data=$(fetch_asset_data "$normalized_asset")
  price=$(echo "$data" | cut -d':' -f1)
  pct=$(echo "$data" | cut -d':' -f2)

  display_name="${normalized_asset#xyz:}"
  quotes+=("$display_name: $price (${pct}%)")
done

echo "${quotes[*]}"
