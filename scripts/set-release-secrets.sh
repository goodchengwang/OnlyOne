#!/usr/bin/env bash
# Sets the four repository secrets a vX.Y.Z tag needs to deploy that release's web client to the Worker
# (release.yml › deploy-web). Run it once from a checkout whose ignored .env deployed the cloud; the three
# non-secret values are read from there, and the API token is typed in without echo.
#
#   bash scripts/set-release-secrets.sh [path/to/.env]
#
# Agents are barred from `gh secret` (src/gates.ts), so this is an owner step. Nothing here prints a value.
set -euo pipefail

env_file=${1:-.env}
repo=${GH_REPO:-$(git remote get-url origin | sed -E 's#(.*[:/])([^/]+/[^/]+)$#\2#; s#\.git$##')}

# The ignored .env of a checkout that ran `bun run deploy:cloud`, else the same values exported.
value() {
  local line v=""
  if [ -f "$env_file" ]; then
    line=$(grep -E "^$1=" "$env_file" | tail -n 1) || true
    line=${line#*=}
    line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
    v=$line
  fi
  [ -n "$v" ] || { v=$(printenv "$1") || true; }
  printf '%s' "$v"
}

worker=$(value ONLYONE_WORKER_NAME || true)
account=$(value CLOUDFLARE_ACCOUNT_ID || true)
domain=$(value ONLYONE_DOMAIN || true)
[[ $worker =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "$env_file needs ONLYONE_WORKER_NAME, the Worker name (in $env_file or exported)." >&2; exit 1; }
[[ $account =~ ^[a-f0-9]{32}$ ]] || { echo "$env_file needs CLOUDFLARE_ACCOUNT_ID, the 32-character account id (in $env_file or exported)." >&2; exit 1; }
[[ $domain =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "$env_file needs ONLYONE_DOMAIN, the custom domain the Worker serves (in $env_file or exported)." >&2; exit 1; }
echo "Repository: $repo"
echo "Worker:     $worker (account ${account:0:6}…, $domain)"

token=${CLOUDFLARE_API_TOKEN:-}
if [ -z "$token" ]; then
  printf 'CLOUDFLARE_API_TOKEN (Workers Scripts: Edit, Zone Workers Routes: Edit; input hidden): '
  read -rs token || true
  echo
fi
[ -n "$token" ] || { echo "No API token given." >&2; exit 1; }

# A token that cannot verify would only surface at the next tag, after every package is built.
verify=$(curl -sS -H "Authorization: Bearer $token" https://api.cloudflare.com/client/v4/user/tokens/verify) || true
printf '%s' "$verify" | grep -q '"status":"active"' || { echo "Cloudflare rejected that token: $verify" >&2; exit 1; }
echo "Token:      active"

# One request per secret. The token goes in on stdin so it never lands in the command line or `ps`.
printf '%s' "$token" | gh secret set CLOUDFLARE_API_TOKEN -R "$repo"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$account" -R "$repo"
gh secret set ONLYONE_WORKER_NAME --body "$worker" -R "$repo"
gh secret set ONLYONE_DOMAIN --body "$domain" -R "$repo"

unset token
# GitHub returns names and update times only, so this reads back what landed without exposing any value.
list=$(gh secret list -R "$repo")
missing=0
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ONLYONE_WORKER_NAME ONLYONE_DOMAIN; do
  grep -qE "^$name[[:space:]]" <<< "$list" || { echo "Missing after set: $name" >&2; missing=1; }
done
if [ "$missing" = 0 ]; then echo "All four secrets are set; the next vX.Y.Z tag deploys https://$domain and verifies it."; fi
exit "$missing"
