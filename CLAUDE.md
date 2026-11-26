# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

This project uses [Bun](https://bun.com) as its package manager and script runner (lockfile: `bun.lock`). The published artifact still targets Node.js.

### Development
- `bun install` - Install all dependencies including devDependencies
- `bun run dev` - Start the development server with file watching (uses tsx watch)
- `bun run build` - Build the TypeScript project and generate CLI binary (bin/cli.mjs)

### Testing
- `bun run test` - Run all tests once with Vitest
- `bun run test:dev` - Run tests in watch mode
- Run a specific test file: `bunx vitest run src/proxy/__tests__/stdio-proxy.test.ts`

### Code Quality
- `bun run lint` - Check code formatting with ESLint
- `bun run lint:fix` - Auto-fix formatting issues with ESLint
- `bun run format` - Auto-fix formatting issues with Prettier
- `bun run typecheck` - Run TypeScript type checking without emitting files

## Architecture Overview

Anytype serves MCP itself, from its local API server at `POST /mcp/{small|large|full}` (anytype-heart `core/api/server/mcp.go`, heart >= 0.51.6). This package is a thin stdio front end for it: hosts that can only launch a command (Claude Desktop) talk newline-delimited JSON-RPC to it, and it forwards each message to `/mcp/<tier>` byte for byte and writes Anytype's answer back byte for byte. It generates no tools; the tool table, descriptions, results and repair hints are Anytype's. There are no runtime dependencies: `bin/cli.mjs` is a self-contained esbuild bundle.

### Core Components

**CLI (`src/cli.ts`, entry `scripts/start-server.ts`)**
- `anytype-mcp [run] [--tier small|large|full]` serves stdio; `anytype-mcp get-key` pairs and prints a key (`src/auth/get-key.ts`)
- Configuration errors are served as answers to every request (the host shows them) instead of exiting

**Configuration (`src/proxy/config.ts`)**
- `OPENAPI_MCP_HEADERS` (JSON headers; `Authorization: Bearer <key>` is what matters), `ANYTYPE_API_BASE_URL`, `ANYTYPE_MCP_TIER`, `ANYTYPE_MCP_FILES_DIR`
- Every header is validated before any request and reported by name only: values hold the API key and must never reach an error message, stdout or stderr

**JSON-RPC routing (`src/proxy/jsonrpc.ts`)**
- `classify` mirrors heart's `wrapper.ClassifyMessage`, so nothing the proxy does itself runs on an envelope heart would refuse
- Request ids are kept as their raw JSON text (`rawMember`, `frameResult`), never re-encoded through a JS number

**HTTP side (`src/proxy/heart-client.ts`)**
- One POST per message; 202 for notifications; HTTP-level failures (401/403/404/429, unreachable, redirect) are classified and rendered by `describeFailure`
- Curated tiers: `Mcp-Session-Id` (recorded when the headers arrive) from initialize, sent on every message, renewed once — initialize and then notifications/initialized, shared by every waiting message — after heart expires it. Session resets are two counters: `generation` (resets so far, bumped by the first message to see the session gone) and `delivered` (advanced by stdio only when the write of `SESSION_EXPIRED` to a live request has completed; a failed stdout write stops the proxy). A `tools/call` request runs only if `delivered` when it arrived equals `generation`; nothing else consumes or clears a reset. A renewal needs heart's 202 for its notifications/initialized and runs under a proxy-lifetime signal (`shutdown()`). A refused or broken initialize ends the session heart minted, and nothing but ping runs until an initialize succeeds. `close()` (one shared promise for EOF and signals) waits for a pending initialize and DELETEs the session
- Non-2xx is handled first: heart's HTTP 400 JSON-RPC envelope error is rebuilt (`rpcError`: request id, reserved-range code, bounded redacted message); every other refusal goes through `anytypeError`, which requires heart's `status`/`code`/`message`
- Redirects are never followed; error bodies are read bounded, and only heart's documented error fields are quoted, with configured credentials redacted (`src/proxy/errors.ts`). The reply bound (128 MiB) covers heart's 32 MiB body carried twice

**stdio side (`src/proxy/stdio-proxy.ts`)**
- `readLines` frames stdin with heart's 8 MiB limit; `StdioProxy.receive` registers each request synchronously so a `notifications/cancelled` in the same read can stop it
- Negotiates its own protocol revision (`chooseVersion`; 2025-03-26 is not offered because it requires batches)
- On the full tier, appends the local file tools to `tools/list` and dispatches calls to them

**Local file tools (`src/proxy/local-tools.ts`, `src/proxy/files.ts`)**
- `upload_local_file` and `download_file`, against heart's v2 REST file routes with the caller's key, confined to one root directory (default `~/.anytype-mcp/files`): relative paths only, realpath containment, `O_NOFOLLOW|O_NONBLOCK` and a regular-file check on upload, downloads streamed to a temporary file and published with a no-overwrite hard link (no hard links: the download fails), named `properties.name` + `file_ext` and shortened by UTF-8 bytes, whole-file (HTTP 200) only, streaming multipart upload whose success requires heart's receipt
- They step aside if heart lists a tool with the same name

### Key Design Patterns

1. **Pass-through, not translation**: the proxy parses only to route. Anything it must change (initialize's revision, the tools/list append, its own errors) is re-framed under the request's raw id.
2. **Fail loudly at the boundary**: errors only a process boundary can know (Anytype down, key rejected, no `/mcp`) become in-band tool errors on `tools/call` and JSON-RPC errors elsewhere, with "ask the user" guidance.
3. **Secrets stay out of diagnostics**: header values are validated up front; network errors are reported by system code only.

## Testing Strategy

Tests use Vitest and are colocated with source files in `__tests__` directories. `src/proxy/__tests__/fake-heart.ts` is a fake API server written from heart's `/mcp` contract (auth, tiers, sessions, 202, plain-404 for an Anytype without `/mcp`, the v2 file routes, an `intercept` hook for 429s, delays and redirects). Key test areas:
- the HTTP contract and session renewal (`heart-client.test.ts`)
- stdio framing, cancellation, envelope validation, revisions, shutdown (`stdio-proxy.test.ts`)
- the MCP SDK client end to end through the proxy (`sdk-client.test.ts`)
- the files root (`local-tools.test.ts`) and configuration (`config.test.ts`)

## Code Style

- Prettier with 120 character line width
- Double quotes for strings
- Automatic import organization via prettier-plugin-organize-imports
- TypeScript strict mode enabled
