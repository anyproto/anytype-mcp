# MCP tool behavior

## How it works

`anytype-mcp` is a stdio front end for the MCP server built into Anytype, which needs Anytype with heart 0.51.6 or later. Each JSON-RPC message the MCP client writes to stdin is POSTed byte for byte to `<base URL>/mcp/<tier>`, and Anytype's answer is written back to stdout byte for byte. Tools, their descriptions, results and error hints all come from Anytype, so they match the app you run.

- Base URL: `ANYTYPE_API_BASE_URL` (origin only), default `http://127.0.0.1:31009`. `anytype-cli` listens on `31012`. If the variable is set but is not an `http://` or `https://` URL, the proxy refuses to start rather than send the key to the default port.
- Credentials: the `Authorization` header from `OPENAPI_MCP_HEADERS`. Every call runs as that key, with its scope and space grants. Other headers in that variable are sent too.
  - `Content-Type`, `Accept`, `Mcp-Session-Id` and `MCP-Protocol-Version` belong to the transport and are ignored.
  - `If-Match`, `Idempotency-Key`, `Range` and the other conditional headers belong to a single request, so the proxy refuses to start with them.
- Tier: `--tier small|large|full`, else `ANYTYPE_MCP_TIER`, else `full`.
- Files: `ANYTYPE_MCP_FILES_DIR`, else `~/.anytype-mcp/files` (see below).

The proxy checks the configuration before sending anything. A problem, such as JSON that does not parse or a header value with a line break, is answered on every request with a message that names the variable and header, never a header's value. The MCP host then shows the reason.

## Tiers

- `full`: one tool per API operation, named by its operation id (`list_spaces`, `create_object`, `patch_object`, `list_chats`, `add_chat_message`, `upload_file`, ...). It keeps no session. Large schemas are served as lookups: `patch_object` and `update_type` take an `ops` list whose members `get_op_schema` describes, and document bodies point at `get_schema`. Anytype leaves out pairing and key management, event streams, typing status, and binary downloads.
- `small` and `large`: compact task tools (`spaces`, `find`, `read`, `create`, ...) that number results and refer back to them. Anytype keeps those numbers in a session.
  - The proxy opens the session at `initialize`, sends its id with every message, and ends it when the client disconnects.
  - Anytype ends a session after 30 idle minutes. The proxy then opens a new one, but it does not run the tool call that found the session gone: its numbers could name different objects in the new session. That call fails with a message telling the model to re-read its targets, and the next call runs normally.

## Local file tools (full tier)

Anytype's MCP server cannot read or write files on the computer running the MCP client, so on `full` the proxy adds two tools it runs itself, with the same key, against Anytype's REST API. Both use one directory only: `ANYTYPE_MCP_FILES_DIR`, else `~/.anytype-mcp/files`. The directory is created on first use with mode `0700`. Their descriptions name the directory, and so do their refusals, so the model can tell the user where files go.

- `upload_local_file` takes `space_id` and a `path` relative to the directory, plus optional `dry_run`. It streams the file to Anytype as a multipart upload and returns the stored file object, the same as `upload_file`, which takes a `url`.
  - Refused before the filesystem is consulted: absolute, home (`~`), drive and UNC paths, `\\.\` device paths, and `..` segments that leave the directory.
  - A symbolic link that resolves outside the directory is refused too.
- `download_file` takes `space_id`, `file_id`, and an optional image `width`. It fetches the whole file (any `Range` or conditional header is dropped, and anything but HTTP 200 is refused) and saves it into the directory with mode `0600`. It returns `path`, `filename`, `media_type` and `size`.
  - The name comes from the file object's name, plus an extension for common media types.
  - An existing file is never overwritten: the next free name is used (`report (2).pdf`), and an interrupted download leaves nothing behind.

If Anytype starts serving a tool with one of these names, its version is listed and the local one is not.

## Errors

- Tool failures come from Anytype as tool results with `isError: true`, with Anytype's message, issues and hints.
- When Anytype cannot be asked at all, the proxy answers itself. That covers Anytype not running, the key rejected (`401`) or refused (`403`), too many calls at once (`429`), a redirect (never followed), and an Anytype without the MCP server (`404`, with the version it needs and the `@2.0.3` pin). On `tools/call` the answer is an `isError` result that tells the model to ask the user; on other methods it is a JSON-RPC error with the same text. Only Anytype's own error message is quoted, never another server's page.
- Messages Anytype would refuse as malformed are refused by the proxy first, with the same JSON-RPC errors, and nothing runs for them. That includes batches, a wrong `jsonrpc` member, and `null` or object ids. Lines longer than 8 MiB, Anytype's limit, are refused as they arrive.
- `notifications/cancelled` stops the call it names, whether or not it has been sent yet, and the cancelled call gets no answer. Request ids pass through as written, so `9007199254740993` stays exact.
- The stdio side answers a client's protocol revision when it can carry it: 2024-11-05, 2025-06-18 or 2025-11-25. Anytype's HTTP server speaks the last two; for a tools-only server the older one differs only in optional fields. A 2025-03-26 client is answered with 2024-11-05, because 2025-03-26 requires JSON-RPC batches, which Anytype refuses.
- When stdin closes, every call already received is answered, then the session ends. On SIGINT or SIGTERM, calls in flight are cancelled first.

## Debugging

Set `ANYTYPE_MCP_DEBUG=1` to log each forwarded method with its HTTP status and timing to stderr. Debug logs omit arguments, headers, payloads and tool definitions.
