# Anna's Archive API Reference

Anna's Archive is an open-source search engine for shadow libraries, indexing 60M+ books and 95M+ papers. This reference documents how to interact with their API and data.

## Important: Domain Instability

Anna's Archive domains are frequently suspended due to legal action. The `.org` and `.se` domains were taken down in January 2026. **Never hardcode a domain.** Always check the [Anna's Archive Wikipedia page](https://en.wikipedia.org/wiki/Anna%27s_Archive) for the latest working URL. All API paths below use `<base_url>` as a placeholder — substitute the current working domain.

## Official API

Anna's Archive has one stable JSON API endpoint for members:

### Fast Download

```
GET <base_url>/dyn/api/fast_download.json
```

**Parameters:**
- `md5` (required): the MD5 hash identifying the book/file
- `key` (required): API key obtained via donation

**Authentication:**
- Requires a paid API key
- Obtain a key by donating at `https://annas-archive.gl/donate?r=A8V5hcf`
- API access details are at `/faq#api` on the current domain

**Response:**
- Returns a JSON object containing a fast download URL for the specified file
- The endpoint is self-documenting — calling it without parameters returns usage instructions

**Example:**
```
GET <base_url>/dyn/api/fast_download.json?md5=abc123def456&key=YOUR_KEY
```

### Web Search (Not a JSON API)

The search functionality at `<base_url>/search` is a **web endpoint** that returns HTML, not a documented JSON API. Parameters include:

- `q`: search query
- `ext`: format filter (pdf, epub, mobi, azw3, djvu)
- `sort`: sorting (e.g., `year_desc`)
- `content`: content type (book_fiction, book_nonfiction, book_comic, magazine, standards_document)
- `lang`: language filter

This is the web interface, not meant for programmatic use.

## Dataset Torrents

Anna's Archive publishes their full datasets as torrents. The torrent list is available as JSON:

```
GET <base_url>/dyn/torrents.json
```

**Response:** Array of torrent objects:
```json
{
  "display_name": "annas_archive_meta__aacid__zlib3_records__20240809T171652Z--20260211T235731Z.jsonl.seekable.zst.torrent",
  "magnet_link": "magnet:?xt=urn:btih:...",
  "data_size": 42949672960,
  "obsolete": false,
  "added_to_torrents_list_at": "2026-02-11T23:57:31Z"
}
```

### Key Datasets

| Dataset | Description | Approximate Size |
|---|---|---|
| `zlib3_records` | Book metadata (title, author, MD5, ISBN, file info) | ~40 GB compressed |
| `goodreads_records` | Ratings, reviews, genres, descriptions (static Sep 2024 snapshot, not regularly updated) | ~5 GB compressed |

Files are JSONL format, compressed with seekable zstd (`.seekable.zst`). The date range in the filename (e.g., `20240809T171652Z--20260211T235731Z`) indicates the record date range covered by that file. Anna's Archive publishes **incremental files** — each covering a specific time window, not a full snapshot. Multiple files for the same source should all be imported; the importers handle deduplication via upserts on `source_id`.

### Data Format: Zlib3 Records

Each line is a JSON object representing an AAC (Anna's Archive Container) record:

```json
{
  "aacid": "aacid__zlib3_records__20240809T171652Z__12345678",
  "metadata": {
    "record": {
      "zlibrary_id": 12345678,
      "title": "Book Title",
      "author": "Author Name",
      "publisher": "Publisher",
      "language": "English",
      "year": "2020",
      "extension": "epub",
      "filesize": 524288,
      "md5": "abc123def456...",
      "isbn": "9780441172719",
      "description": "Book description text",
      "series": "Series Name",
      "edition": "1st",
      "pages": "350"
    }
  }
}
```

### Data Format: Goodreads Records

```json
{
  "aacid": "aacid__goodreads_records__20240913T115838Z__work_12345",
  "metadata": {
    "record": {
      "id": "12345",
      "title": "Book Title",
      "author": "Author Name",
      "rating": "4.27",
      "ratings_count": "1200000",
      "description": "Book description",
      "genres": ["Science Fiction", "Fiction"],
      "isbn": "9780441172719",
      "pages": "350",
      "year": "1965"
    }
  }
}
```

## Relationship Between This API and Anna's Archive

The self-hosted Book Search API (this project) uses the **dataset torrents** listed above — it downloads and imports them locally. It does **not** call Anna's Archive at runtime.

The workflow for downloading actual book files:

1. Search for a book using **this API** (`/search`, `/similar`, `/lookup`)
2. Get the `md5` hash from the results
3. Use that `md5` with the **Anna's Archive fast download API** to get a download URL
4. Download the file from the URL returned

This separation means the search API works offline and doesn't depend on Anna's Archive availability, while actual file downloads require an active Anna's Archive API key and network access.

## Mirrors and Base URLs

Anna's Archive domains are taken down regularly. Domains that have existed at various points:
- `annas-archive.org` (suspended Jan 2026)
- `annas-archive.se` (suspended Jan 2026)
- `annas-archive.pm` (suspended)
- `annas-archive.li` (suspended Mar 2026)
- `annas-archive.gl` (working as of Mar 2026)
- `annas-archive.pk` (working as of Mar 2026)
- `annas-archive.vg` (working as of Mar 2026)
- `annas-archive.gd` (working as of Mar 2026)

**This list will be outdated.** Always check the [Wikipedia article](https://en.wikipedia.org/wiki/Anna%27s_Archive) for current domains.

The API paths (`/dyn/api/fast_download.json`, `/dyn/torrents.json`, `/donate?r=A8V5hcf`, `/faq`) work on any active mirror. Set the `ANNAS_BASE_URL` environment variable in the project to the current working domain.

## Rate Limits and Usage Notes

- The fast download API is for **personal use** with a valid key
- The torrent list endpoint (`/dyn/torrents.json`) is public and has no authentication
- Dataset torrents are public and freely downloadable
- Anna's Archive recommends using their datasets for building custom search rather than scraping the web interface
