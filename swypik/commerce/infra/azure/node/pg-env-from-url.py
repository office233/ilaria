#!/usr/bin/env python3
"""Transformă DATABASE_URL (din env `DBURL`) în `export PGHOST=... PGPASSWORD=...`.

deploy.sh face `eval "$(DBURL=... python3 pg-env-from-url.py)"` ca psql să se
conecteze prin variabile de mediu: parola nu mai apare în argv (vizibilă în
`ps` pentru orice user de pe VM). URL-ul vine prin env, nu ca argument.
"""
import os
import shlex
import sys
from urllib.parse import parse_qs, unquote, urlsplit


def main() -> int:
    raw = os.environ.get("DBURL", "").strip()
    if not raw:
        print("pg-env-from-url: DBURL lipsește", file=sys.stderr)
        return 2
    u = urlsplit(raw)
    if u.scheme not in ("postgres", "postgresql"):
        print("pg-env-from-url: schemă nesuportată", file=sys.stderr)
        return 2
    env = {
        "PGHOST": u.hostname or "",
        "PGPORT": str(u.port or 5432),
        "PGUSER": unquote(u.username or ""),
        "PGPASSWORD": unquote(u.password or ""),
        "PGDATABASE": unquote(u.path.lstrip("/")),
    }
    sslmode = parse_qs(u.query).get("sslmode")
    if sslmode:
        env["PGSSLMODE"] = sslmode[0]
    for key, value in env.items():
        if value:
            print(f"export {key}={shlex.quote(value)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
