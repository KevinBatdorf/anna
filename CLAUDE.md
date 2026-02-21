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
- **Database**: PostgreSQL 17 via Drizzle ORM + raw postgres.js
- **Search**: Postgres FTS with weighted tsvector (generated columns + GIN indexes), optional vector search via pgvector + Ollama
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

- FTS uses `plainto_tsquery('english', q)` — no sanitization needed, Postgres handles it safely
- Book search deduplicates by title+author, preferring PDF > epub > other
- Vector search is opt-in (requires `OLLAMA_URL` env var), embeddings stored directly on goodreads table via pgvector
- Tests require a running Postgres instance (use `docker compose up -d postgres`)
- When creating or changing API endpoints, update the Yaak workspace in `yaak/` to match
