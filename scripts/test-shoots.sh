#!/usr/bin/env bash
# =============================================================================
# Shoot Engine — End-to-end curl test
# =============================================================================
# Usage:
#   chmod +x scripts/test-shoots.sh
#   ./scripts/test-shoots.sh
#
# Prerequisites:
#   - wrangler dev running on localhost:8787
#   - A verified user account already exists (or run the signup block first)
#   - A real garment image at ./test-garment.jpg (or change GARMENT_IMAGE below)
#
# What this does:
#   1. Login  → save session cookie
#   2. Create project → get projectId
#   3. Upload garment image → get assetId
#   4. Run shoot engine (streaming SSE) → print each event as it arrives
#   5. Fetch generated image via R2 proxy
# =============================================================================

BASE="http://localhost:8787"
COOKIES="/tmp/allore-cookies.txt"
GARMENT_IMAGE="./test-garment.jpg"   # ← change to a real garment image path

# Colours for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

sep() { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# =============================================================================
# OPTIONAL: Create account (skip if already have one)
# =============================================================================
# sep
# echo -e "${YELLOW}[0] Signup${NC}"
# curl -s -X POST "$BASE/auth/signup" \
#   -H "Content-Type: application/json" \
#   -d '{"email":"test@alloreai.com","password":"password123","name":"Test User"}' | jq .

# =============================================================================
# 1. LOGIN
# =============================================================================
sep
echo -e "${YELLOW}[1] Login${NC}"

LOGIN=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -c "$COOKIES" \
  -d '{"email":"test@alloreai.com","password":"password123"}')

echo "$LOGIN" | jq .

if echo "$LOGIN" | grep -q '"error"'; then
  echo "Login failed — check credentials or run the signup block"
  exit 1
fi

echo -e "${GREEN}✓ Logged in — cookie saved to $COOKIES${NC}"

# =============================================================================
# 2. UPLOAD GARMENT IMAGE (no projectId required)
# =============================================================================
sep
echo -e "${YELLOW}[2] Upload garment image${NC}"

if [ ! -f "$GARMENT_IMAGE" ]; then
  echo "ERROR: Garment image not found at $GARMENT_IMAGE"
  echo "Download a test image:"
  echo "  curl -Lo test-garment.jpg 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800'"
  exit 1
fi

# projectId is optional — pass a placeholder so the upload route doesn't reject it
UPLOAD=$(curl -s -X POST "$BASE/assets/upload" \
  -b "$COOKIES" \
  -F "file=@$GARMENT_IMAGE" \
  -F "projectId=test-project" \
  -F "type=garment" \
  -F "subtype=product_image")

echo "$UPLOAD" | jq .

ASSET_ID=$(echo "$UPLOAD" | jq -r '.asset.id')

if [ "$ASSET_ID" = "null" ] || [ -z "$ASSET_ID" ]; then
  echo "Upload failed — check asset upload service"
  exit 1
fi

echo -e "${GREEN}✓ Asset ID: $ASSET_ID${NC}"

# =============================================================================
# 4. RUN SHOOT ENGINE (streaming SSE)
# =============================================================================
sep
echo -e "${YELLOW}[4] Run shoot engine — streaming${NC}"
echo "Intent: 3 clean editorial shots, white studio background, on model"
echo ""

# --no-buffer keeps curl from buffering the SSE stream
# We parse each 'data: ...' line and pretty-print it
curl -s -N -X POST "$BASE/shoots/generate" \
  -H "Content-Type: application/json" \
  -b "$COOKIES" \
  --no-buffer \
  -d "{
    \"intent\": \"3 clean editorial shots, white studio background, model facing camera, minimal lighting, show full garment\",
    \"assetIds\": [\"$ASSET_ID\"]
  }" | while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      json="${line#data: }"
      type=$(echo "$json" | jq -r '.type' 2>/dev/null)

      case "$type" in
        "status")
          msg=$(echo "$json" | jq -r '.content')
          echo -e "  ${BLUE}[status]${NC} $msg"
          ;;
        "plan")
          echo -e "\n  ${YELLOW}[plan]${NC}"
          echo "$json" | jq '.steps[]' 2>/dev/null | while read -r step; do
            echo "    → $(echo "$step" | jq -r '"#\(.index) \(.theme) [\(.angle)]"')"
          done
          echo ""
          ;;
        "photoshoots")
          echo ""
          echo "$json" | jq -c '.items[]' | while read -r item; do
            idx=$(echo "$item" | jq -r '.shotIndex')
            theme=$(echo "$item" | jq -r '.theme')
            url=$(echo "$item" | jq -r '.url')
            asset_id=$(echo "$item" | jq -r '.assetId')
            echo -e "  ${GREEN}[image ready]${NC} Shot $idx: $theme"
            echo "    Asset ID : $asset_id"
            echo "    URL      : $BASE$url"
            # Save last URL for step 5
            echo "$BASE$url" > /tmp/allore-last-shot-url.txt
          done
          echo ""
          ;;
        "done")
          total=$(echo "$json" | jq -r '.totalShots')
          echo -e "\n  ${GREEN}[done]${NC} $total shots generated"
          ;;
        "error")
          msg=$(echo "$json" | jq -r '.message')
          echo -e "  \033[0;31m[error]\033[0m $msg"
          ;;
        *)
          echo "  [raw] $json"
          ;;
      esac
    fi
  done

# =============================================================================
# 5. FETCH GENERATED IMAGE (R2 proxy)
# =============================================================================
sep
echo -e "${YELLOW}[5] Fetch generated image via R2 proxy${NC}"

if [ -f "/tmp/allore-last-shot-url.txt" ]; then
  SHOT_URL=$(cat /tmp/allore-last-shot-url.txt)
  echo "Fetching: $SHOT_URL"

  HTTP_CODE=$(curl -s -o /tmp/allore-test-output.jpg \
    -w "%{http_code}" \
    -b "$COOKIES" \
    "$SHOT_URL")

  if [ "$HTTP_CODE" = "200" ]; then
    SIZE=$(wc -c < /tmp/allore-test-output.jpg)
    echo -e "${GREEN}✓ Image fetched — ${SIZE} bytes — saved to /tmp/allore-test-output.jpg${NC}"
    # Open on Mac
    command -v open &>/dev/null && open /tmp/allore-test-output.jpg
  else
    echo "Fetch failed — HTTP $HTTP_CODE"
  fi
else
  echo "No shot URL captured (shoot may have failed)"
fi

sep
echo -e "${GREEN}Done.${NC}"
