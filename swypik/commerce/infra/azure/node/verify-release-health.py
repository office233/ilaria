#!/usr/bin/env python3
"""Validate deployment readiness from JSON; never print the response or secrets."""
import json
import sys


def ready(body, commit):
    if not isinstance(body, dict):
        return False
    release = body.get("release")
    services = body.get("services")
    return (
        body.get("status") == "healthy"
        and isinstance(release, dict)
        and release.get("commit") == commit
        and isinstance(services, dict)
        and services.get("database") == "ok"
        and services.get("redis") == "ok"
        and isinstance(services.get("storage"), dict)
        and services["storage"].get("ok") is True
    )


if __name__ == "__main__":
    try:
        valid = len(sys.argv) == 2 and ready(json.load(sys.stdin), sys.argv[1])
    except (ValueError, TypeError):
        valid = False
    sys.exit(0 if valid else 1)
