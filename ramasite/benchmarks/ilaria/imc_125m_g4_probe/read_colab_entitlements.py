import json
from urllib.parse import urljoin
from colab_cli.common import state
from colab_cli.client import (
    TUN_ENDPOINT,
    ACCEPT_JSON_HEADER,
    COLAB_CLIENT_AGENT_HEADER,
)

client = state.client
url = urljoin(client.colab_domain, f"{TUN_ENDPOINT}/ccu-info")
headers = {
    ACCEPT_JSON_HEADER["key"]: ACCEPT_JSON_HEADER["value"],
    COLAB_CLIENT_AGENT_HEADER["key"]: COLAB_CLIENT_AGENT_HEADER["value"],
}
response = client.session.get(url, headers=headers, params={"authuser": "0"})
response.raise_for_status()
payload = json.loads(client._strip_xssi_prefix(response.text))
safe = {
    "eligibleGpus": payload.get("eligibleGpus"),
    "currentBalance": payload.get("currentBalance"),
    "consumptionRateHourly": payload.get("consumptionRateHourly"),
    "assignmentsCount": payload.get("assignmentsCount"),
}
print(json.dumps(safe, indent=2, sort_keys=True))
