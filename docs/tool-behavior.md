# MCP tool behavior

## API discovery

At startup the MCP server fetches `/v2/docs/openapi.json`. A `404` or `410` triggers a fallback to `/docs/openapi.json` on the same server. Authentication failures, connection failures, server errors, and invalid specs fail startup. Discovery runs once per process, so restart MCP after upgrading Anytype.

To use v1 explicitly with the Desktop API, pass its versioned spec URL:

```json
{
  "args": ["-y", "@anyproto/anytype-mcp", "run", "http://127.0.0.1:31009/v1/docs/openapi.json"]
}
```

Use `/v2/docs/openapi.json` to select v2 explicitly. An explicit URL or local spec file skips fallback. Requests use the routes declared in the selected spec. If two operations produce the same MCP tool name, startup fails with both routes in the error.

## Inputs and writes

- Set `Authorization` and `Anytype-Version` in `OPENAPI_MCP_HEADERS`. Header arguments are matched by their OpenAPI parameter location so document fields retain their meaning.
- Open-ended JSON documents use the `body` argument. Bodies with declared fields use flat arguments. Generated v1 search tools omit the `filters` field.
- Use `expected_etag` with the etag from a previous read to avoid overwriting a changed object. The wrapper sends it as `If-Match` and surfaces a failed precondition. Response etags appear in `request_metadata`.
- On endpoints that accept `Idempotency-Key`, omit `request_key` for a new write. The wrapper generates a key and returns it in `request_metadata` or the error's `request_key` field. Reuse it only to retry the same write. Each new write gets a fresh key and the wrapper leaves retries to the caller.
- Existing clients can use the legacy argument names `If-Match` and `Idempotency-Key`. Conflicting aliases and a global `Idempotency-Key` in `OPENAPI_MCP_HEADERS` are rejected.

Pagination, field selection, `dry_run`, `create_missing_options`, and schema discovery are available where the selected API exposes them.

## Results and tool names

Failed tool calls return `isError: true`, the HTTP status when available, and the API's code, message, issues, and hints. Successful v1 object writes and chat creation return a compact receipt with object identity and any write metadata. Read the object to retrieve its content. v2 supplies its own compact write receipts. Reads, searches, and errors retain their API responses.

MCP tool names are derived from OpenAPI operation IDs, such as `list_properties` becoming `API-list-properties`. Tool descriptions and schema field descriptions use those MCP names. Repair hint text refers to MCP tools and their arguments. Typed `see_also` entries keep their REST references and gain `tool` and `args` fields. The wrapper preserves literal values and output schemas. OpenAI and Anthropic tool exports use the original operation IDs.

## Credentials, streams, and downloads

- Pairing and API key management belong to the host configuration. Use v2 `API-auth-whoami` to inspect the current key's permissions.
- MCP excludes event streams. Use the chat message-listing tools for a bounded result.
- `API-download-file` streams bytes to a private temporary directory and returns `path`, `filename`, `media_type`, and `size`. Paths are local to the host or container running MCP. Completed files remain until removed or cleaned up by the OS. Interrupted downloads are removed. Range and cache headers are managed outside tool inputs.

Set `ANYTYPE_MCP_DEBUG=1` to log operation names, status, and timing to stderr. Debug logs omit arguments, authorization headers, payloads, and tool definitions.
