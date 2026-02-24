# Anna's Archive Book Search API

> Klanker disclosure: This project was vibe-coded.

A self-hosted REST API for searching and discovering books, powered by data from [Anna's Archive](https://annas-archive.li?r=A8V5hcf) and Goodreads.

Downloads two open datasets via torrent (Zlib3 book metadata + Goodreads ratings), imports them into PostgreSQL with full-text search, and serves a JSON API. Does **not** host or serve any book files — it's a metadata search engine.

The `/download` endpoint requires an `ANNAS_API_KEY` — see Anna's Archive for how to obtain one. Search and recommendations work without it.

## Setup

```sh
cp .env.example .env   # edit to set API key, etc.
docker compose up -d
```

The API container downloads the full datasets via torrent (~40 GB for books, ~5 GB for Goodreads) and imports them into PostgreSQL automatically. The API is live at `http://localhost:3100` once the first import finishes.

## Data Updates

The API checks for new data daily but won't download more than once every 30 days (configurable via `UPDATE_INTERVAL_DAYS` in `.env`). Each update downloads the full dataset torrents again — Anna's Archive publishes incremental files, and the importer deduplicates via upsert, so existing records are updated in place. Embeddings are preserved across reimports since row IDs stay stable.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /search?q=...` | Full-text search across book records |
| `GET /search/goodreads?q=...` | Search Goodreads ratings & reviews |
| `GET /similar?q=...` | Find similar books by ISBN or exact title |
| `GET /lookup/md5?md5=...` | Look up a book by MD5 hash |
| `GET /lookup/isbn?isbn=...` | Look up by ISBN (books + Goodreads) |
| `GET /download?md5=...` | Get download URL (requires `ANNAS_API_KEY`) |
| `GET /stats` | Database stats and import info |
| `POST /mcp` | MCP protocol endpoint (JSON-RPC 2.0) |

`/search` supports `?ext=pdf` to filter by format and `?dedupe=false` to show all formats (default deduplicates by title+author, keeping PDF > epub > other).

`/similar` accepts an ISBN (most accurate) or an exact book title. Supports `?min_rating=` and `?min_reviews=` to filter results by quality. Each result includes `similarity` (0-1) and `available` (true/false for downloadable copies).

See `skills/book-search/SKILL.md` for detailed API docs and agent workflows.

## Semantic Search (Optional)

For better search quality, you can enable vector embeddings powered by [Ollama](https://ollama.ai). Set `OLLAMA_URL` in `.env` and pull `nomic-embed-text` (`ollama pull nomic-embed-text`). The updater will embed Goodreads records incrementally — this is fully resumable, so it picks up where it left off across restarts. When embeddings are available, `/search/goodreads` and `/similar` use vector similarity instead of keyword matching.

You can add `OLLAMA_URL` at any time — even after the initial data import. The API checks every 24 hours and will start embedding automatically on its next cycle. To start immediately, restart the container: `docker compose restart api`. The importer validates database integrity before starting embeddings — if corruption is detected, it logs the errors and skips the embedding pass rather than wasting hours on bad data.

**Heads up:** The initial embedding of the full Goodreads catalog (~11M records) will roughly double your database size and takes a while — speed depends entirely on your GPU. On an RTX 4090 it takes about 21 hours (~149 records/sec); slower hardware could take days or weeks. Subsequent updates only embed new records, so after the first run it stays quick. You can set `LIMIT=1000` in `.env` to embed a small batch first and verify everything works before committing to the full run.

## MCP Server

The API includes a built-in [MCP](https://modelcontextprotocol.io) endpoint at `POST /mcp`, so any MCP-compatible client (Claude Desktop, Claude Code, etc.) can use it as a tool server.

Add to your MCP client config:

```json
{
  "mcpServers": {
    "anna": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Available tools: `search_books`, `search_goodreads`, `find_similar`, `lookup_isbn`, `lookup_md5`, `get_stats`, `get_download_url`. Hit `GET /mcp` for a quick summary.

The `find_similar` tool accepts an ISBN (preferred) or exact book title. Pass an ISBN when available for the most reliable match.

The `get_download_url` tool returns a temporary direct download URL for a book file. To actually download and read the file content (PDF, EPUB, etc.), pair this server with an MCP tool that can fetch URLs and parse document formats.

## Claude Code Plugin

This project includes a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) so Claude can search for books from any project.

To install it, add an entry to your `~/.claude/plugins/installed_plugins.json`:

```json
{
  "anna-book-search@local": [
    {
      "scope": "user",
      "installPath": "/absolute/path/to/anna",
      "version": "0.2.0",
      "installedAt": "2026-01-01T00:00:00.000Z",
      "lastUpdated": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Replace `installPath` with the absolute path to this repo on your machine. After restarting Claude Code, the book search skill will be available in all conversations.
