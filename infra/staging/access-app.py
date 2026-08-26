"""Build the Access application payload from the environment.

Kept apart from the shell script so the policy is readable on its own, and so a mistake
in it fails loudly here rather than being sent to Cloudflare as malformed JSON.
"""

import json
import os

include = [
    {"email_domain": {"domain": d.strip()}}
    for d in os.environ["ACCESS_ALLOWED_DOMAINS"].split(",")
    if d.strip()
]
include += [
    {"email": {"email": e.strip()}}
    for e in os.environ["ACCESS_ALLOWED_EMAILS"].split(",")
    if e.strip()
]
if not include:
    raise SystemExit("Refusing to create a policy that allows nobody in.")

print(
    json.dumps(
        {
            "name": os.environ["ACCESS_APP_NAME"],
            "domain": os.environ["ACCESS_HOSTNAME"],
            "type": "self_hosted",
            "session_duration": "24h",
            "app_launcher_visible": True,
            # False so the sign-in page lists the options rather than assuming one.
            "auto_redirect_to_identity": False,
            "policies": [
                {
                    "name": "Team and owner",
                    "decision": "allow",
                    "precedence": 1,
                    "include": include,
                }
            ],
        }
    )
)
