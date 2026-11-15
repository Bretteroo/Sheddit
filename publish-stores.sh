#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Submit the version in src/manifest.json to Firefox Add-ons and the Chrome
# Web Store, where each goes through the store's review.
#
#   ./publish-stores.sh           build, then submit to both stores
#   ./publish-stores.sh --check   only confirm both stores accept the
#                                 credentials and show their current versions
#
# Credentials are never printed. They come from these environment variables,
# which the GitHub workflow sets from the repository's secrets:
#
#   AMO_JWT_ISSUER, AMO_JWT_SECRET  Firefox Add-ons API key
#   CWS_PUBLISHER_ID                Chrome Web Store publisher
#   CWS_SERVICE_ACCOUNT_JSON        key for the Google service account linked
#                                   to that publisher
#
# or, run by hand, from ~/.config/sheddit/stores.env (the first three) and
# ~/.config/sheddit/cws-service-account.json (the key).
#
# .github/workflows/publish-stores.yml runs it when a release is published
# on GitHub. If a store turns the submission down, fix the problem and run the
# workflow again from the Actions tab, or run this script by hand.
set -eu
cd "$(dirname "$0")"

if [ -z "${CWS_SERVICE_ACCOUNT_JSON:-}" ]; then
  config="${SHEDDIT_STORES_DIR:-$HOME/.config/sheddit}"
  if [ ! -r "$config/stores.env" ] || [ ! -r "$config/cws-service-account.json" ]; then
    echo "Missing credentials (see the top of this script)." >&2
    exit 1
  fi
  set -a
  . "$config/stores.env"
  set +a
  export CWS_KEY_FILE="$config/cws-service-account.json"
fi
for name in AMO_JWT_ISSUER AMO_JWT_SECRET CWS_PUBLISHER_ID; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing $name (see the top of this script)." >&2
    exit 1
  fi
done

check=false
if [ "${1:-}" = "--check" ]; then
  check=true
elif [ -n "${1:-}" ]; then
  echo "usage: ./publish-stores.sh [--check]" >&2
  exit 1
fi

if ! $check; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Commit your changes first, so the stores get what was released." >&2
    exit 1
  fi
  ./build.sh >/dev/null
fi

# Both stores' APIs, in Python: Firefox Add-ons signs requests with a JWT
# made from the API key, and Google trades a JWT signed with the service
# account's key for an access token.
CHECK=$check python3 - <<'PY'
import base64, hashlib, hmac, json, os, sys, time, urllib.error, urllib.parse, urllib.request, uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ADDON = "sheddit@sheddit"
ITEM = "olemfeakjfaeimedbgakkjcdknncpgpf"
CHECK = os.environ["CHECK"] == "true"
version = json.load(open("src/manifest.json"))["version"]


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt(header, claims, sign):
    head = b64(json.dumps(header).encode()) + "." + b64(json.dumps(claims).encode())
    return head + "." + b64(sign(head.encode()))


def call(method, url, token, body=None, content_type=None, scheme="Bearer"):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"{scheme} {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        sys.exit(f"{method} {url.split('?')[0]} failed: HTTP {err.code} {detail}")


def amo_token():
    now = int(time.time())
    claims = {"iss": os.environ["AMO_JWT_ISSUER"], "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}
    secret = os.environ["AMO_JWT_SECRET"].encode()
    return jwt({"alg": "HS256", "typ": "JWT"}, claims,
               lambda msg: hmac.new(secret, msg, hashlib.sha256).digest())


def google_token():
    raw = os.environ.get("CWS_SERVICE_ACCOUNT_JSON") or open(os.environ["CWS_KEY_FILE"]).read()
    key_info = json.loads(raw)
    key = serialization.load_pem_private_key(key_info["private_key"].encode(), password=None)
    now = int(time.time())
    claims = {
        "iss": key_info["client_email"],
        "scope": "https://www.googleapis.com/auth/chromewebstore",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    assertion = jwt({"alg": "RS256", "typ": "JWT"}, claims,
                    lambda msg: key.sign(msg, padding.PKCS1v15(), hashes.SHA256()))
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read())["access_token"]
    except urllib.error.HTTPError as err:
        sys.exit(f"Google sign-in for the service account failed: HTTP {err.code} "
                 f"{err.read().decode(errors='replace')[:300]}")


cws = f"https://chromewebstore.googleapis.com/v2/publishers/{os.environ['CWS_PUBLISHER_ID']}/items/{ITEM}"

# Firefox Add-ons: the account behind the key, and the listed version.
me = call("GET", "https://addons.mozilla.org/api/v5/accounts/profile/", amo_token(), scheme="JWT")
addon = call("GET", f"https://addons.mozilla.org/api/v5/addons/addon/{ADDON}/", amo_token(), scheme="JWT")
print(f"Firefox Add-ons: signed in as {me.get('name') or me.get('username')}; "
      f"listed version {addon.get('current_version', {}).get('version', '?')}")

# Chrome Web Store: the item's status under the publisher.
gtoken = google_token()
status = call("GET", f"{cws}:fetchStatus", gtoken)
published = (status.get("publishedItemRevisionStatus") or {}).get("distributionChannels") or []
live = ", ".join(sorted({c.get("crxVersion", "?") for c in published})) or "?"
print(f"Chrome Web Store: service account accepted; published version {live}")

if CHECK:
    print(f"Credentials work. This checkout is version {version}.")
    sys.exit(0)

# Chrome Web Store: upload the package, wait for it to be processed, then
# submit it for review. It publishes itself once it passes.
with open("dist/sheddit-chrome.zip", "rb") as f:
    up = call("POST", f"https://chromewebstore.googleapis.com/upload/v2/publishers/"
              f"{os.environ['CWS_PUBLISHER_ID']}/items/{ITEM}:upload", gtoken, f.read(), "application/zip")
state = up.get("uploadState")
for _ in range(30):
    if state != "IN_PROGRESS":
        break
    time.sleep(5)
    state = (call("GET", f"{cws}:fetchStatus", gtoken).get("lastAsyncUploadState") or state)
if state != "SUCCEEDED":
    sys.exit(f"Chrome Web Store upload didn't succeed: {json.dumps(up)[:500]}")
call("POST", f"{cws}:publish", gtoken, b"{}", "application/json")
print(f"Chrome Web Store: version {version} uploaded and submitted for review.")
PY

if ! $check; then
  # Firefox Add-ons: web-ext uploads src/ as a new listed version and returns
  # once it's submitted; Mozilla's review takes it from there.
  WEB_EXT_API_KEY="$AMO_JWT_ISSUER" WEB_EXT_API_SECRET="$AMO_JWT_SECRET" \
    npx -y web-ext@8 sign --source-dir src --artifacts-dir dist/amo \
      --channel listed --approval-timeout 0
  echo "Firefox Add-ons: version submitted for review."
fi
