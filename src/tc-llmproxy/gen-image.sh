#!/usr/bin/env bash
# Generate one image through tc-llmproxy and save it locally.
# Usage: gen-image.sh <proxy-url> <model-name> <prompt> <output-image-path>
set -euo pipefail

usage() {
  printf 'Usage: %s <proxy-url> <model-name> <prompt> <output-image-path>\n' "${0##*/}" >&2
  exit 2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 4 ] || usage
for command in curl python3; do
  command -v "$command" >/dev/null 2>&1 || die "missing dependency: $command"
done

PROXY_URL="${1%/}"
MODEL="$2"
PROMPT="$3"
OUTPUT_PATH="$4"
[ -n "$PROXY_URL" ] || die "proxy URL must not be empty"
[ -n "$MODEL" ] || die "model name must not be empty"
[ -n "$PROMPT" ] || die "prompt must not be empty"

OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUTPUT_DIR"
RESPONSE_FILE="$(mktemp)"
IMAGE_FILE="$(mktemp "${OUTPUT_DIR}/.gen-image.XXXXXX")"
trap 'rm -f "$RESPONSE_FILE" "$IMAGE_FILE"' EXIT

BODY="$(python3 -c '
import json, sys
print(json.dumps({"model": sys.argv[1], "prompt": sys.argv[2]}, ensure_ascii=False))
' "$MODEL" "$PROMPT")"

HTTP_CODE="$(printf '%s' "$BODY" | curl -sS -X POST "${PROXY_URL}/cmd/gen-image" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data-binary @- \
  --max-time 120 \
  -o "$RESPONSE_FILE" \
  -w '%{http_code}')" || die "request failed"

if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  SUMMARY="$(python3 -c '
import sys
print(open(sys.argv[1], "rb").read(300).decode("utf-8", "replace"))
' "$RESPONSE_FILE")"
  die "proxy returned HTTP $HTTP_CODE: $SUMMARY"
fi

RESULT_KIND="$(python3 - "$RESPONSE_FILE" "$IMAGE_FILE" <<'PY'
import base64
import binascii
import json
import sys
from urllib.parse import urlparse

response_path, image_path = sys.argv[1:]
try:
    payload = json.load(open(response_path, encoding="utf-8"))
    image = payload["data"][0]
except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
    sys.exit("invalid image response: %s" % exc)

encoded = image.get("b64_json") if isinstance(image, dict) else None
if isinstance(encoded, str) and encoded:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        sys.exit("invalid b64_json: %s" % exc)
    if not raw:
        sys.exit("b64_json contains no image data")
    with open(image_path, "wb") as output:
        output.write(raw)
    print("saved")
    sys.exit(0)

url = image.get("url") if isinstance(image, dict) else None
if isinstance(url, str) and url:
    if urlparse(url).scheme not in {"http", "https"}:
        sys.exit("image URL must use http or https")
    print("url=" + url)
    sys.exit(0)

sys.exit("image response contains neither data[0].b64_json nor data[0].url")
PY
)" || die "failed to parse image response"

if [[ "$RESULT_KIND" == url=* ]]; then
  curl -fsSL --max-time 120 "${RESULT_KIND#url=}" -o "$IMAGE_FILE" || die "failed to download generated image"
fi

[ -s "$IMAGE_FILE" ] || die "generated image is empty"
mv -f "$IMAGE_FILE" "$OUTPUT_PATH"
printf '%s\n' "$OUTPUT_PATH"
