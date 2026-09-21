#!/usr/bin/env python3
"""Fetch a held-out Romanian+English Wikipedia evaluation set.

Collects plain-text extracts of Wikipedia articles CREATED on or after
2025-01-01, from ro.wikipedia.org and en.wikipedia.org. Because the training
corpus for the target language model (Wikipedia dump 2023-11-01, FineWeb-2 RO,
FineWeb-Edu EN) predates 2025, articles created in 2025+ are very unlikely to
have leaked into training data, making them a clean held-out perplexity set.

Uses only the Python standard library (urllib) against the MediaWiki Action
API. Strategy:

  1. `list=search` with a very common word (so the match set is close to
     "all articles") and `srsort=create_timestamp_desc` to get candidate
     titles ordered from most-recently-created to oldest. Since "today" is
     long after 2025-01-01, the newest-created pages trivially satisfy the
     creation-date filter; we still verify each one explicitly.
  2. For each candidate title, one combined `prop=extracts|revisions|
     pageprops|info` request:
       - `prop=revisions&rvdir=newer&rvlimit=1` -> timestamp of the FIRST
         revision, i.e. the actual page-creation timestamp (source of truth,
         independent of the search ordering).
       - `prop=pageprops&ppprop=disambiguation` -> presence of this pageprop
         marks a disambiguation page (dropped).
       - `prop=info` -> a `"redirect": ""` key marks the title itself as a
         redirect (dropped, not resolved).
       - `prop=extracts&explaintext=1` -> the plain-text article body.
  3. Keep articles whose creation timestamp is >= 2025-01-01, that are not
     redirects/disambiguation pages, and whose cleaned extract has at least
     MIN_CHARS characters. Trim to ~MAX_CHARS characters, cut back to the
     last full sentence.

Outputs (next to this script):
  - heldout_wiki_2025.txt            one article's extract per paragraph
                                      block, blocks separated by a blank line
  - heldout_wiki_2025.manifest.json  metadata per block, same order
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "nexus-cortex-eval/1.0 (https://github.com/office233/Nexuscortex)"
MIN_REQUEST_INTERVAL = 0.55  # seconds -> <= ~1.8 req/s, safely under the 2 req/s cap
MAX_RETRIES = 4
RETRY_BACKOFF = 1.5  # seconds, doubled each retry

TARGET_COUNT = 20
MAX_CHARS = 2500
MIN_CHARS_DEFAULT = 1500
MIN_CHARS_FALLBACK = 800
CUTOFF_ISO = "2025-01-01T00:00:00Z"
MAX_CANDIDATES = 400  # safety cap on how many candidate titles we will inspect

LANGS = {
    "en": {
        "api": "https://en.wikipedia.org/w/api.php",
        "search_word": "the",
        "license": "CC BY-SA 4.0, Wikipedia contributors",
    },
    "ro": {
        "api": "https://ro.wikipedia.org/w/api.php",
        "search_word": "de",
        "license": "CC BY-SA 4.0, Wikipedia contributors",
    },
}

# Romanian cedilla variants -> correct comma-below diacritics.
RO_DIACRITIC_FIX = str.maketrans({
    "ş": "ș",  # ş -> ș
    "Ş": "Ș",  # Ş -> Ș
    "ţ": "ț",  # ţ -> ț
    "Ţ": "Ț",  # Ţ -> Ț
})

SENTENCE_END_RE = re.compile(r"[.!?][\"'”’)]*\s")
HEADING_RE = re.compile(r"^\s*=+\s*.*?\s*=+\s*$")
REF_BRACKET_RE = re.compile(r"\[\d+\]")

_last_request_time = 0.0

# Windows consoles often default to a legacy code page (e.g. cp1250) that
# can't encode Romanian diacritics in our progress prints; force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def throttled_get(url: str, params: dict) -> dict:
    """GET the MediaWiki API with a User-Agent, rate limiting, and retries."""
    global _last_request_time
    query = urllib.parse.urlencode(params)
    full_url = f"{url}?{query}"

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        elapsed = time.monotonic() - _last_request_time
        if elapsed < MIN_REQUEST_INTERVAL:
            time.sleep(MIN_REQUEST_INTERVAL - elapsed)
        _last_request_time = time.monotonic()

        req = urllib.request.Request(full_url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            return json.loads(data.decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                json.JSONDecodeError, ConnectionError) as exc:
            last_err = exc
            if attempt < MAX_RETRIES:
                backoff = RETRY_BACKOFF * (2 ** (attempt - 1))
                print(f"  [retry {attempt}/{MAX_RETRIES}] {exc} -> sleeping {backoff:.1f}s",
                      file=sys.stderr)
                time.sleep(backoff)
    raise RuntimeError(f"request failed after {MAX_RETRIES} attempts: {last_err}") from last_err


def search_candidate_titles(api: str, search_word: str, max_candidates: int):
    """Yield namespace-0 titles ordered newest-created first."""
    sroffset = 0
    seen = set()
    fetched = 0
    while fetched < max_candidates:
        params = {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": search_word,
            "srnamespace": 0,
            "srsort": "create_timestamp_desc",
            "srlimit": 50,
            "sroffset": sroffset,
            "srprop": "",
        }
        data = throttled_get(api, params)
        results = data.get("query", {}).get("search", [])
        if not results:
            return
        for r in results:
            title = r["title"]
            if title not in seen:
                seen.add(title)
                fetched += 1
                yield title
        cont = data.get("continue", {})
        if "sroffset" not in cont:
            return
        sroffset = cont["sroffset"]


def fetch_page_details(api: str, title: str) -> dict | None:
    params = {
        "action": "query",
        "format": "json",
        "titles": title,
        "prop": "extracts|revisions|pageprops|info",
        "explaintext": 1,
        "exlimit": 1,
        "rvprop": "timestamp",
        "rvlimit": 1,
        "rvdir": "newer",
        "ppprop": "disambiguation",
        "inprop": "url",
        "redirects": 0,
    }
    data = throttled_get(api, params)
    pages = data.get("query", {}).get("pages", {})
    if not pages:
        return None
    page = next(iter(pages.values()))
    if "missing" in page or "invalid" in page:
        return None
    return page


def clean_extract(raw: str) -> str:
    lines = []
    for line in raw.split("\n"):
        if HEADING_RE.match(line):
            continue  # drop "== Section ==" heading lines entirely
        line = line.strip()
        if line:
            lines.append(line)
    text = " ".join(lines)  # collapse to a single flowing paragraph block
    text = REF_BRACKET_RE.sub("", text)
    text = re.sub(r" {2,}", " ", text)
    text = text.strip()
    return text


def trim_to_sentence(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text.strip()
    window = text[:max_chars]
    last_end = None
    for m in SENTENCE_END_RE.finditer(window):
        last_end = m.end()
    if last_end and last_end >= max_chars * 0.4:
        return window[:last_end].strip()
    return window.strip()


def is_creation_after_cutoff(created_iso: str) -> bool:
    return created_iso >= CUTOFF_ISO  # ISO-8601 UTC 'Z' strings compare lexicographically


def collect_for_lang(lang: str, cfg: dict, target: int):
    api = cfg["api"]
    articles = []
    min_chars = MIN_CHARS_DEFAULT
    used_fallback = False
    inspected = 0

    def run_pass(min_chars_threshold):
        nonlocal inspected
        for title in search_candidate_titles(api, cfg["search_word"], MAX_CANDIDATES):
            if len(articles) >= target:
                return
            inspected += 1
            try:
                page = fetch_page_details(api, title)
            except RuntimeError as exc:
                print(f"  [skip] {title!r}: {exc}", file=sys.stderr)
                continue
            if page is None:
                continue
            if "redirect" in page:
                continue
            if "pageprops" in page and "disambiguation" in page.get("pageprops", {}):
                continue
            revisions = page.get("revisions")
            if not revisions:
                continue
            created = revisions[0].get("timestamp")
            if not created or not is_creation_after_cutoff(created):
                continue
            extract = page.get("extract", "")
            if not extract:
                continue
            cleaned = clean_extract(extract)
            if lang == "ro":
                cleaned = cleaned.translate(RO_DIACRITIC_FIX)
            if len(cleaned) < min_chars_threshold:
                continue
            trimmed = trim_to_sentence(cleaned, MAX_CHARS)
            if len(trimmed) < 200:  # degenerate cut, skip
                continue
            title_clean = title.translate(RO_DIACRITIC_FIX) if lang == "ro" else title
            articles.append({
                "language": lang,
                "title": title_clean,
                "url": page.get("fullurl", f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"),
                "created": created,
                "char_count": len(trimmed),
                "license": cfg["license"],
                "text": trimmed,
            })
            print(f"  [{lang}] +{len(articles):02d}/{target} '{title_clean}' "
                  f"({len(trimmed)} chars, created {created})")

    print(f"== {lang}: pass 1 (min_chars={min_chars}) ==")
    run_pass(min_chars)

    if len(articles) < target:
        used_fallback = True
        min_chars = MIN_CHARS_FALLBACK
        print(f"== {lang}: only {len(articles)}/{target} found; "
              f"lowering threshold to {min_chars} chars and re-scanning ==")
        articles = []
        inspected = 0
        run_pass(min_chars)

    return articles, min_chars, used_fallback, inspected


def main():
    out_dir = Path(__file__).resolve().parent
    txt_path = out_dir / "heldout_wiki_2025.txt"
    manifest_path = out_dir / "heldout_wiki_2025.manifest.json"

    all_articles = []
    summary = {}
    for lang, cfg in LANGS.items():
        articles, min_chars_used, used_fallback, inspected = collect_for_lang(lang, cfg, TARGET_COUNT)
        summary[lang] = {
            "count": len(articles),
            "min_chars_used": min_chars_used,
            "used_fallback": used_fallback,
            "candidates_inspected": inspected,
            "total_chars": sum(a["char_count"] for a in articles),
        }
        all_articles.extend(articles)

    blocks = [a["text"] for a in all_articles]
    txt_content = "\n\n".join(blocks) + "\n"
    with open(txt_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(txt_content)

    manifest = [
        {
            "language": a["language"],
            "title": a["title"],
            "url": a["url"],
            "created": a["created"],
            "char_count": a["char_count"],
            "license": a["license"],
        }
        for a in all_articles
    ]
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("\n=== SUMMARY ===")
    for lang, s in summary.items():
        print(f"{lang}: {s['count']} articles, {s['total_chars']} chars total, "
              f"min_chars_used={s['min_chars_used']}, fallback_used={s['used_fallback']}, "
              f"candidates_inspected={s['candidates_inspected']}")
    print(f"Wrote {txt_path}")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
