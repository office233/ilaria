# Swypik's own search engine — implemented scope

Crawler + persistent inverted index + BM25 ranker. It is not a metasearch wrapper.
Queries never go to DuckDuckGo, Google, Bing or Brave. Empty indexes return empty
results. Fabricated source URLs, answers and tracker counters were removed.

## Pipeline

Explicit seed and consent -> same-origin sequential crawl -> robots check ->
HTML extraction -> URL-keyed document upsert -> inverted index -> BM25 query ->
source URL, excerpt, score, fetch timestamp and SHA-256.

Production crawls use SwypikBot identification, a one-second minimum delay per
request, two-minute context deadline, 1 MiB page limit, 512 KiB robots limit,
1-32 fetches and a bounded frontier. The native UI selects eight fetches.
No scripts, forms, cookies or credentials are executed.

DNS is resolved at connection time, all answers must be public, and dialing uses
the validated IP. Private, loopback, link-local, CGNAT, documentation and selected
transition ranges are blocked. Environment HTTP proxies are disabled. Redirects
are manual, stay within the original origin and pass through the robots gate.
No public API allows private-network crawling.

The robots parser implements user-agent selection, allow/disallow, wildcard and
longest-match preference. This is a conservative subset, **not complete RFC 9309
compliance**. Only 404/410 mean absent robots; redirects, 403/429 and server errors
stop the crawl. Meta/header noindex and nofollow are honored conservatively.
Encountered newly blocked/noindex/404 pages are deleted from the local index.
A complete recrawl/deletion scheduler remains necessary.

Extraction uses the standard library tolerant XML token decoder and static-HTML
preprocessing, **not an HTML5 browser parser**. Malformed or script-rendered pages
may be unsupported. A maintained HTML5 parser, sitemap support, charset detection
and canonical-link handling remain work, not silently promised functionality.

## Index and ranking

The first index is capped at 1,000 documents and 32 KiB extracted text per page.
Unicode token boundaries, limited Romanian diacritic folding, BM25 k1=1.2/b=0.75,
and doubled title terms rank lexical relevance. Scores do not establish truth.
Top ten results contain actual indexed provenance. No AI answer is fabricated.

A versioned, bounded JSON snapshot is saved through a same-directory temporary
file, file sync and rename before committing an in-memory change. Single process,
not sharded storage and not a guarantee of power-loss recovery. In the RAM-only
image it survives a service restart but **not a reboot**.

## Internet-scale work not implemented

Distributed persistent crawl frontier, host-aware scheduling and full robots
caching/compliance, removal/abuse handling, deduplication, spam controls, freshness,
sharded storage, ranking evaluations, language coverage, observability and capacity
measurement. The engine is a testable own-index foundation, not Google-scale coverage.

Reference: https://www.rfc-editor.org/rfc/rfc9309.html
