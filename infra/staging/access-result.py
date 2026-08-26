"""Report what Cloudflare did with the application payload.

Separate from the shell script so the failure advice is written once, in plain Python,
rather than escaped through two layers of quoting.
"""

import json
import sys

d = json.load(sys.stdin)

if not d.get("success"):
    print("Failed:", json.dumps(d.get("errors"), indent=2))
    print()
    print("A 1010 auth.forbidden, or a 10000 authentication error, means the token is")
    print("missing Access: Apps and Policies (Edit). Reading apps succeeds without it,")
    print("so a token that lists applications fine can still be unable to create one.")
    raise SystemExit(1)

result = d["result"]
print(f"  {result['name']} -> {result['domain']}")
print(f"  application id {result['id']}")
print(f"  audience tag   {result.get('aud')}")
print()
print("  With no identity provider configured, Access uses its own one-time PIN: an")
print("  allowed address receives a code by email. Nothing else needs setting up.")
