---
name: book-search
description: This skill should be used when the user asks to "find a book", "search for books", "recommend books", "look up a book by ISBN", "look up a book by MD5", "check book ratings", "find book availability", "get book recommendations", or needs to query a self-hosted Anna's Archive book search API. Also use when the user mentions "anna", "anna's archive", "goodreads ratings", or wants to download a book using an MD5 hash.
---

# Book Search & Recommendations

This skill provides access to a self-hosted REST API that indexes book records from Anna's Archive (Zlib3). Optionally includes Goodreads ratings/reviews (a static Sep 2024 snapshot — useful for ratings, genres, and vector search but not regularly updated). Search for books, get recommendations, and look up metadata by ISBN or MD5 hash. Call `/stats` to see current record counts.

## API Base URL

The API runs locally. Default: `http://localhost:3100`

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /search?q=...&author=&publisher=&language=&year=&ext=&dedupe=true&limit=20&offset=0` | Search Zlib3 book records (FTS + filters) |
| `GET /search/goodreads?q=...&author=&year=&genre=&search_type=&limit=20&offset=0` | Search Goodreads ratings & reviews — optional, static Sep 2024 snapshot |
| `GET /similar?q=...&limit=10&min_rating=0&min_reviews=0` | Similar books via vector search — requires Goodreads + Ollama |
| `GET /lookup/md5?md5=...` | Look up a book by MD5 hash |
| `GET /lookup/isbn?isbn=...` | Look up by ISBN (returns both book file + Goodreads data) |
| `GET /download?md5=...` | Get download URL (proxies Anna's Archive API) |
| `GET /stats` | Database stats (books/goodreads counts, import status, embeddings %) |

### Search

```
GET /search?q=<query>&author=&publisher=&language=&year=&ext=pdf&dedupe=true&limit=20&offset=0
```

Returns Zlib3 records: title, author, publisher, language, year, extension, filesize, pages, md5, isbn, series.

Either `q` or at least one filter is required. All params are optional and can be combined:
- `q` — full-text search across title, author, publisher, description, ISBN
- `author` — filter by author (partial match, e.g. `author=Tolkien`)
- `publisher` — filter by publisher (partial match, e.g. `publisher=No Starch`)
- `language` — filter by language (exact match, e.g. `language=english`)
- `year` — filter by publication year (exact match, e.g. `year=2024`)
- `ext` — filter by file format (e.g. `ext=pdf`, `ext=epub`)
- `dedupe` — deduplicate results by title+author, keeping the best format (pdf > epub > other). Default: `true`.

When `q` is provided, results are sorted by relevance. Without `q`, sorted by newest first.

### Search Goodreads (optional)

Goodreads data is a static snapshot from September 2024 — useful for ratings, genres, descriptions, and semantic vector search, but not regularly updated by Anna's Archive.

```
GET /search/goodreads?q=<query>&author=&year=&genre=&search_type=&limit=20&offset=0
```

Returns Goodreads entries: title, author, rating, ratings_count, description, genres, isbn, pages, year. Vector results also include `similarity` (0-1).

Either `q` or at least one filter is required:
- `q` — full-text search (uses vector search when available, otherwise FTS)
- `author` — filter by author (partial match)
- `year` — filter by publication year (exact match)
- `genre` — filter by genre (partial match, e.g. `genre=fantasy`)
- `search_type` — force search method: `fts` (full-text only) or `vector` (vector only). Default: auto (vector for plain `q` with no filters, FTS otherwise). Returns `400` if `vector` is requested but unavailable.

By default, vector search is used for plain `q` queries with no filters, falling back to FTS. When filters are present, FTS is always used. Without `q`, results are sorted by rating (highest first).

### Similar

```
GET /similar?q=<isbn_or_title>&limit=10&min_rating=0&min_reviews=0
```

Find books similar to a given book using vector embeddings. The `q` parameter accepts an **ISBN** (preferred) or an **exact book title**.

**How matching works:**
- **ISBN** (10-13 digits): Direct lookup — fastest and most reliable
- **Title**: FTS search + strict word-level matching against the main title (before any `:` subtitle). The query words must cover at least 60% of the title words. Partial or vague titles will return `found: false`.

**Best practice:** Always pass an ISBN when available. Title matching is strict by design (this API is built for AI agents, not fuzzy human queries).

**Response shape:**
- `found: true` — matched a Goodreads entry. Returns `source` (the matched book) and `results` (similar books). Each result has `similarity` (0-1) and `available` (true/false for downloadable copies).
- `found: false` — no Goodreads match. May include a `download` object if the book exists in the books table (Zlib3).

Optional parameters:
- `min_rating` — minimum Goodreads rating (e.g. `min_rating=3.5`). Default: `0` (no filter).
- `min_reviews` — minimum number of ratings (e.g. `min_reviews=100`). Default: `0` (no filter).

Returns `503` if vector search is not configured.

### Lookup

- `GET /lookup/md5?md5=<hash>` — returns book record
- `GET /lookup/isbn?isbn=<isbn>` — returns `{ book, goodreads }` (either may be `null`)

### Download

```
GET /download?md5=<hash>
```

Proxies the Anna's Archive fast download API. Requires `ANNAS_API_KEY` in the server's `.env`. Returns `503` if not configured.

The response includes `account_fast_download_info` with `downloads_left`, `downloads_per_day`, and `downloads_done_today`. Check these to avoid exceeding the daily limit.

## Choosing the Right Endpoint

| User intent | Endpoint | Why |
|---|---|---|
| Specific title/author ("Do you have Dune?") | `/search?q=dune+frank+herbert` | FTS keyword match, returns downloadable files |
| Publisher browsing ("No Starch Press books") | `/search?publisher=no+starch` | Direct publisher filter, no FTS needed |
| Author catalog ("books by Kernighan") | `/search?author=kernighan` | Direct author filter |
| Filtered search ("Python books in English") | `/search?q=python&language=english` | FTS + language filter |
| Topical discovery ("books about stoicism") | `/search/goodreads?q=stoicism` | Semantic vec search across Goodreads catalog |
| Genre browsing ("fantasy books") | `/search/goodreads?genre=fantasy` | Direct genre filter on Goodreads |
| Quality picks ("recommend a sci-fi book") | `/similar` with `min_rating=3.5&min_reviews=100` | Vec search + rating filter |
| Similar books ("books like Project Hail Mary") | `/similar?q=<isbn>` | ISBN gives best match; falls back to title |
| Rating/metadata lookup | `/lookup/isbn` or `/lookup/md5` | Direct lookup by identifier |

## Agent Workflows

### "Do you have Dune?"

1. Call `/search?q=dune+frank+herbert` — returns one result per book (PDF preferred)
2. If ISBN is known, call `/lookup/isbn?isbn=<isbn>` for Goodreads data too
3. Report format, size, and rating
4. If user wants a different format, use `dedupe=false` to see all available formats

### "Find me books like Project Hail Mary"

1. Call `/lookup/isbn?isbn=<isbn>` or `/search/goodreads?q=project+hail+mary` to get the ISBN
2. Call `/similar?q=<isbn>` — ISBN gives the most reliable match
3. If no ISBN available, fall back to `/similar?q=project+hail+mary` (exact title match required)
4. Results include a `source` field (the matched book) and semantically similar books with `available: true/false`
5. If user wants a file and `available` is true, look up the ISBN via `/lookup/isbn` then `/download?md5=<hash>`

### "Find me a good science fiction book"

1. Call `/search/goodreads?q=science+fiction` for semantic search across the catalog
2. Present top results with ratings
3. For similar-to recommendations, pick a book and call `/similar?q=<isbn>`

### "Books about stoicism" (topical/vague query)

1. Call `/search/goodreads?q=stoicism` — uses vector search for semantic matching
2. Present results with ratings and descriptions
3. Do NOT use `/similar` for vague queries — it requires an exact book title or ISBN

### "What's the rating for this book?" (given an MD5)

1. Call `/lookup/md5?md5=<hash>` to get ISBN
2. Call `/lookup/isbn?isbn=<isbn>` for Goodreads rating

## Handling Domain Errors

If `/download` returns a `502`, or any Anna's Archive request fails, the configured domain is likely dead. **Only in this case**, resolve a new domain:

1. Run `bun run scripts/resolve-domain.ts` from the project root — it fetches the [Anna's Archive Wikipedia page](https://en.wikipedia.org/wiki/Anna%27s_Archive), extracts candidate `annas-archive.*` domains, tests each against `/dyn/torrents.json`, and prints the first working one
2. Update `ANNAS_BASE_URL` in the project's `.env` file to the working domain
3. Restart the API and updater containers to pick up the change

Do not proactively check the domain — only resolve when an actual request fails.

## Error Codes

- `400`: missing required parameter
- `404`: no matching record
- `500`: search/database error
- `502`: upstream Anna's Archive request failed
- `503`: `ANNAS_API_KEY` not configured, or vector search not available (for `/similar`)

## Additional Resources

- **`references/annas-archive-api.md`** — Full Anna's Archive API docs, dataset formats, and authentication details
