#!/usr/bin/env bash
# Put Cloudflare Access in front of the staging hostname.
#
# Idempotent: creates the application if it is missing, updates it in place if it is not.
# Nothing here is secret, so it lives in the repository; the token is read from the
# environment and never written to disk.
#
#   CLOUDFLARE_API_TOKEN=... bash infra/staging/apply-access.sh
#
# The token needs these permission groups, which are not in a default API token:
#   Account -> Access: Apps and Policies                         -> Edit
#   Account -> Access: Organizations, Identity Providers, Groups -> Read
set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-8e1ad5d05c20ef6ebdcc8c0040a6dddc}"
ACCESS_HOSTNAME="${ACCESS_HOSTNAME:-consultnow.ayonix.com}"
ACCESS_APP_NAME="${ACCESS_APP_NAME:-UXE Consulting AI (staging)}"
# Comma separated. Everyone at these domains may sign in.
ACCESS_ALLOWED_DOMAINS="${ACCESS_ALLOWED_DOMAINS:-ayonix.com}"
# Comma separated. Individual addresses outside those domains.
ACCESS_ALLOWED_EMAILS="${ACCESS_ALLOWED_EMAILS:-drsadivural@gmail.com}"
export ACCESS_HOSTNAME ACCESS_APP_NAME ACCESS_ALLOWED_DOMAINS ACCESS_ALLOWED_EMAILS

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "${method}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "content-type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}" "$@"
}

body="$(python3 "$(dirname "$0")/access-app.py")"

existing="$(api GET /access/apps | python3 -c '
import sys, json, os
apps = json.load(sys.stdin).get("result") or []
target = os.environ["ACCESS_HOSTNAME"]
print(next((a["id"] for a in apps if a.get("domain") == target), ""))
')"

if [[ -n "${existing}" ]]; then
  echo "==> Updating the existing application (${existing})"
  result="$(api PUT "/access/apps/${existing}" --data "${body}")"
else
  echo "==> Creating the application"
  result="$(api POST /access/apps --data "${body}")"
fi

printf '%s' "${result}" | python3 "$(dirname "$0")/access-result.py"

echo
echo "Automated checks against the public hostname will now meet the Access login page."
echo "Give them a service token and a second policy, or point them at 127.0.0.1:4173,"
echo "which serves the same stack from behind the tunnel."
