# MCP tool behavior

## How it works

`anytype-mcp` is a stdio front end for the MCP server built into Anytype. Each JSON-RPC message the MCP client writes to stdin is POSTed to `<base URL>/mcp/<tier>` and Anytype's answer is written back to stdout unchanged. Tools, their descriptions, results and error hints all come from Anytype, so they match the app you run.

- Base URL: `ANYTYPE_API_BASE_URL` (origin only), default `http://127.0.0.1:31009`. `anytype-cli` listens on `31012`.
- Credentials: the `Authorization` header from `OPENAPI_MCP_HEADERS`. Every call runs as that key, with its scope and space grants. Other headers in that variable are sent too. `Content-Type`, `Accept`, `Mcp-Session-Id` and `MCP-Protocol-Version` are reserved for the transport and are ignored.
- Tier: `--tier small|large|full`, else `ANYTYPE_MCP_TIER`, else `full`.

## Tiers

- `full`: one tool per API operation, named by its operation id (`list_spaces`, `create_object`, `patch_object`, `list_chats`, `add_chat_message`, `upload_file`, ...). It keeps no session. Large schemas are served as lookups: `patch_object` and `update_type` take an `ops` list whose members `get_op_schema` describes, and document bodies point at `get_schema`. Anytype leaves out pairing and key management, event streams, typing status, and binary downloads.
- `small` and `large`: compact task tools (`spaces`, `find`, `read`, `create`, ...) that number results and refer back to them. Anytype keeps those numbers in a session. The proxy opens the session at `initialize`, sends its id with every message, re-opens it if Anytype expires it after 30 idle minutes, and ends it when stdin closes. Numbers from before an expiry are gone, and the tool's error says to search again.

## Local file tools (full tier)

Anytype's MCP server cannot read or write files on the computer running the MCP client, so on `full` the proxy adds two tools it runs itself, with the same key, against Anytype's REST API:

- `upload_local_file` takes `space_id` and an absolute `path` (`~/` is expanded), plus optional `dry_run`. It returns the stored file object, the same as `upload_file`, which takes a `url`.
- `download_file` takes `space_id` and `file_id`. It streams the file to a private temporary directory (mode `0600`) and returns `path`, `filename`, `media_type` and `size`. The file stays until it is removed or the OS cleans it up.

If Anytype starts serving a tool with one of these names, its version is listed and the local one is not.

## Errors

- Tool failures come from Anytype as tool results with `isError: true`, with Anytype's message, issues and hints.
- When Anytype cannot be asked at all, the proxy answers itself: Anytype not running, the key rejected (`401`) or refused (`403`), too many calls at once (`429`), or an Anytype without the MCP server (`404`). On `tools/call` the answer is an `isError` result that tells the model to ask the user. On other methods it is a JSON-RPC error with the same text.
- `notifications/cancelled` aborts the forwarded HTTP request, and the cancelled call gets no answer.
- The stdio side answers the protocol revision the client asks for (2024-11-05 through 2025-11-25). Anytype's HTTP server speaks 2025-06-18 and 2025-11-25. The tools are the same in all of them.

## Generated-tools mode (legacy)

Before Anytype served MCP itself, this package generated tools from Anytype's OpenAPI document. That mode remains for one transition period and starts in two cases:

- when a spec is named explicitly, for example `anytype-mcp run http://127.0.0.1:31009/v1/docs/openapi.json`. An explicit URL or file is used as given, and `--tier` does not apply;
- when Anytype answers `initialize` with a plain `404` because it has no `/mcp` route. The proxy logs the fallback to stderr and loads `/v2/docs/openapi.json`, or `/docs/openapi.json` on older apps.

In this mode, tool names carry an `API-` prefix (`API-list-spaces`). `expected_etag` maps to `If-Match`, and `request_key` is the `Idempotency-Key`, generated when omitted and returned in `request_metadata`. `API-download-file` saves to a temporary file as above, and `API-upload-file` takes a local `file` path. Event streams and pairing are excluded.

## Debugging

Set `ANYTYPE_MCP_DEBUG=1` to log each forwarded method with its HTTP status and timing to stderr. Debug logs omit arguments, headers, payloads and tool definitions.
