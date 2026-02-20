---
name: book-search
description: This skill should be used when the user asks to "find a book", "search for books", "recommend books", "look up a book by ISBN", "look up a book by MD5", "check book ratings", "find book availability", "get book recommendations", or needs to query a self-hosted Anna's Archive book search API. Also use when the user mentions "anna", "anna's archive", "goodreads ratings", or wants to download a book using an MD5 hash.
---

# Book Search & Recommendations

This skill provides access to a self-hosted REST API that indexes book records from Anna's Archive (Zlib3) and Goodreads ratings. Search for books, get quality-filtered recommendations, and look up metadata by ISBN or MD5 hash. Call `/stats` to see current record counts.

## API Base URL

The API runs locally. Default: `http://localhost:3100`

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /search?q=...&limit=20&offset=0&ext=&dedupe=true` | Full-text search across Zlib3 book records |
| `GET /search/goodreads?q=...&limit=20&offset=0` | Search Goodreads ratings & reviews |
| `GET /similar?q=...&limit=10&min_rating=0&min_reviews=0` | Semantic book discovery with availability |
| `GET /lookup/md5?md5=...` | Look up a book by MD5 hash |
| `GET /lookup/isbn?isbn=...` | Look up by ISBN (returns both book file + Goodreads data) |
| `GET /download?md5=...` | Get download URL (proxies Anna's Archive API) |
| `GET /stats` | Database stats and import info |

### Search

```
GET /search?q=<query>&limit=20&offset=0&ext=pdf&dedupe=true
```

Returns Zlib3 records: title, author, publisher, language, year, extension, filesize, pages, md5, isbn, series.

Optional parameters:
- `ext` — filter by file format (e.g. `ext=pdf`, `ext=epub`). Only returns books in that format.
- `dedupe` — deduplicate results by title+author, keeping the best format (pdf > epub > other). Default: `true`. Set `dedupe=false` to see all formats.

Results are sorted by relevance, with PDF preferred over epub over other formats. When the user wants a book, prefer searching without `ext` — deduplication ensures one result per book with the best available format.

For Goodreads data specifically: `GET /search/goodreads?q=<query>` — returns title, author, rating, ratings_count, description, genres, isbn, pages, year. Supports vector search (semantic similarity) when embeddings are configured.

### Similar

```
GET /similar?q=<query>&limit=10&min_rating=0&min_reviews=0
```

Semantic book discovery via vector search. If the query matches a known book title, uses that book's description and genres as the search vector (and includes a `source` field in the response). Otherwise, embeds the raw query text directly. Each result includes a `similarity` score (0-1, higher = more similar) and an `available` field with the matching Zlib3 file (by ISBN), or `null`. Returns `503` if vector search is not configured.

Optional parameters:
- `min_rating` — minimum Goodreads rating (e.g. `min_rating=3.5`). Default: `0` (no filter).
- `min_reviews` — minimum number of ratings (e.g. `min_reviews=100`). Default: `0` (no filter).

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
| Specific title/author ("Do you have Dune?") | `/search` | FTS keyword match, returns downloadable files |
| Topical discovery ("books about stoicism") | `/similar` | Semantic vec search + availability |
| Quality picks ("recommend a sci-fi book") | `/similar` with `min_rating=3.5&min_reviews=100` | Vec search + rating filter |
| Similar books ("books like Project Hail Mary") | `/similar` | Looks up the book, then finds similar by description |
| Rating/metadata lookup | `/lookup/isbn` or `/lookup/md5` | Direct lookup by identifier |

## Agent Workflows

### "Do you have Dune?"

1. Call `/search?q=dune+frank+herbert` — returns one result per book (PDF preferred)
2. If ISBN is known, call `/lookup/isbn?isbn=<isbn>` for Goodreads data too
3. Report format, size, and rating
4. If user wants a different format, use `dedupe=false` to see all available formats

### "Find me a good science fiction book"

1. Call `/similar?q=science+fiction&min_rating=3.5&min_reviews=100`
2. Present top results with ratings and availability
3. If user wants a file, call `/download?md5=<hash>` using the `available` field's md5

### "Find me books like Project Hail Mary"

1. Call `/similar?q=project+hail+mary`
2. Results include a `source` field (the matched book) and semantically similar books
3. If user wants a file, use the `available` field's md5 with `/download`

### "Books about stoicism" (topical/vague query)

1. Call `/similar?q=books+about+stoicism`
2. Each result includes an `available` field with the downloadable book (if found by ISBN)
3. If user wants a file, call `/download?md5=<hash>` with the `available` field's md5

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
