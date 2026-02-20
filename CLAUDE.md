# Anna's Archive Book Search API

## Commands

- `bun run dev` — Start the API server locally (port 3100)
- `bun test` — Run all tests
- `bun run lint` — Lint with Biome (errors on warnings)
- `bun run lint:fix` — Auto-fix lint/format issues
- `bun run validate-plugin` — Validate Claude Code plugin structure

## Stack

- **Runtime**: Bun
- **Framework**: Hono
- **Database**: SQLite via Drizzle ORM + raw bun:sqlite
- **Search**: FTS5 with Porter stemming, optional vector search via sqlite-vec + Ollama
- **Linter**: Biome (tabs, single quotes, Bun globals)

## Project Structure

- `src/` — API server (routes, db, lib)
- `scripts/` — Import pipeline, migration, embedding
- `tests/` — Bun test suite
- `skills/book-search/` — Claude Code plugin skill
- `.claude-plugin/` — Plugin manifest

## Status Check

When asked for status, run these and report the results:

- `docker ps --format "table {{.Names}}\t{{.Status}}"` — Container health
- `curl -s http://localhost:3100/stats` — Record counts and import info
- `bun test` — Test suite
- `bun run lint` — Linter

## Workflow

- Work in small, incremental steps — make a change, test it, then move on
- Write a test for every feature or fix you add, and run it before continuing
- Run `bun test` and `bun run lint` before committing — both must pass clean

## Conventions

- All search queries go through `sanitizeFtsQuery()` before hitting FTS5
- Book search deduplicates by title+author, preferring PDF > epub > other
- Vector search is opt-in (requires `OLLAMA_URL` env var)
- Docker runs Debian (not Alpine) because sqlite-vec needs glibc
- When creating or changing API endpoints, update the Yaak workspace in `yaak/` to match
