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
  - Anytype ends a session after 30 idle minutes. The proxy then opens a new one: `initialize`, then `notifications/initialized`, with everything that needs the session waiting until both are answered. No tool call runs across the reset, because its numbers could name different objects in the new session.
  - The rule is one comparison. A tool call runs only if, when it arrived, the client had already been told about every reset. Telling means the proxy wrote the "session expired, re-read your targets" error to a live request (one that has an id and was not cancelled), and that write completed, out of the process. A call that arrives while the warning is still queued is refused too, and if stdout fails, the proxy starts nothing more. Until then every tool call is refused with that error, whichever message found the expiry. Calls that arrived before the warning went out are refused too, even if they are sent after it. Pings, notifications and id-less `tools/call` messages (which Anytype does not run) neither run under that rule nor count as telling.
  - A renewal counts only once Anytype has acknowledged its `notifications/initialized` with HTTP 202. Any other answer ends the half-open session, and so does a signal arriving while the renewal is under way.
  - If Anytype refuses an `initialize`, the session it created for it is ended.
- On every tier, nothing but `ping` runs before an `initialize` has succeeded, local file tools included. Requests sent earlier, or after a refused or malformed `initialize`, are refused and told to initialize first.

## Local file tools (full tier)

Anytype's MCP server cannot read or write files on the computer running the MCP client, so on `full` the proxy adds two tools it runs itself, with the same key, against Anytype's REST API. Both use one directory only: `ANYTYPE_MCP_FILES_DIR`, else `~/.anytype-mcp/files`. The directory is created on first use with mode `0700`. Their descriptions name the directory, and so do their refusals, so the model can tell the user where files go.

- `upload_local_file` takes `space_id` and a `path` relative to the directory, plus optional `dry_run`. It streams the file to Anytype as a multipart upload and returns the stored file object, the same as `upload_file`, which takes a `url`.
  - Refused before the filesystem is consulted: absolute, home (`~`), drive and UNC paths, `\\.\` device paths, and `..` segments that leave the directory.
  - A symbolic link that resolves outside the directory is refused too. The file is opened without following a final link and without blocking, so a named pipe is refused at once instead of waiting for a writer. Only a regular file is uploaded.
  - Limitation: the path is resolved before the file is opened. Someone else who can write inside the directory could swap a folder in between, so the directory should be one only you write to; the default is created with mode `0700`.
- `download_file` takes `space_id`, `file_id`, and an optional image `width`. It fetches the whole file (any `Range` or conditional header is dropped, and anything but HTTP 200 is refused) and returns `path`, `filename`, `media_type` and `size`.
  - The name is the file object's name, which Anytype stores without its extension, joined to its `file_ext`: `report.v2` with `pdf` gives `report.v2.pdf`. Without `file_ext`, the media type's usual extension is added.
  - The bytes stream into a hidden temporary file in the directory (mode `0600`). Only a complete file is published under its name, with a hard link, which never replaces an existing file; the next free name is used instead (`report (2).pdf`). A failed download removes its temporary file and nothing else.
  - The directory must be on a filesystem with hard links. On FAT or exFAT, where no atomic, no-replace publish exists, the download fails with that reason and nothing is saved.
  - Names are shortened at character boundaries to fit 255 UTF-8 bytes, including the extension and room for a ` (2)` suffix, and to 120 characters.
- `upload_local_file` reports success only for Anytype's receipt: HTTP 201 with the stored file's `id`, or for a dry run HTTP 200 with `dry_run: true`. Anything else, such as a proxy's login page or a cut-off body, is reported as an unconfirmed outcome, without quoting it.

If Anytype starts serving a tool with one of these names, its version is listed and the local one is not.

## Errors

- Tool failures come from Anytype as tool results with `isError: true`, with Anytype's message, issues and hints.
- When Anytype cannot be asked at all, the proxy answers itself. That covers Anytype not running, the key rejected (`401`) or refused (`403`), too many calls at once (`429`), a redirect (never followed), and an Anytype without the MCP server (`404`, with the version it needs and the `@2.0.3` pin). On `tools/call` the answer is an `isError` result that tells the model to ask the user; on other methods it is a JSON-RPC error with the same text.
- An HTTP refusal (any status but 2xx) is never relayed as it came, whatever its shape. Two cases are quoted:
  - Anytype's error JSON, which must carry its `status` with `code` and `message`. Only those fields and each issue's `path` and `message` are kept.
  - Anytype's HTTP 400 answer to a malformed envelope. It is rebuilt under the request's id from its JSON-RPC code and message alone; `data` is dropped.

  The text is bounded, and the configured credentials are replaced by `[redacted]`. Any other body, such as a gateway's page or a JSON-RPC-shaped error from something else, is reported by its HTTP status alone.
- Messages Anytype would refuse as malformed are refused by the proxy first, with the same JSON-RPC errors, and nothing runs for them. That includes batches, a wrong `jsonrpc` member, `null` or object ids, and reserved members spelled in another case (`ID`, `Method`), which Anytype's decoder would accept. Lines longer than 8 MiB, Anytype's limit, are refused as they arrive. A reply may be up to 128 MiB, since the full tier returns a result of up to 32 MiB twice, once as text and once as structured content.
- `notifications/cancelled` stops the call it names, whether or not it has been sent yet, and the cancelled call gets no answer. Request ids pass through as written, so `9007199254740993` stays exact.
- The stdio side answers a client's protocol revision when it can carry it: 2024-11-05, 2025-06-18 or 2025-11-25. Anytype's HTTP server speaks the last two; for a tools-only server the older one differs only in optional fields. A 2025-03-26 client is answered with 2024-11-05, because 2025-03-26 requires JSON-RPC batches, which Anytype refuses.
- When stdin closes, every call already received is answered, then the session ends. On SIGINT or SIGTERM, the proxy stops reading at once, cancels calls in flight and forwarded notifications, waits for each to finish its cleanup, ends the session, and exits.

## Large replies and the host's stdio limit

On `full`, Anytype returns each result twice, as text and as `structuredContent`, so a reply is about twice the size of the data read. The proxy accepts up to 128 MiB, but the MCP host reads the proxy's stdout with its own limit. The MCP TypeScript SDK's stdio client stops at 10 MiB per message by default and closes the connection when a message is larger: a single result of about 5 MiB or more, such as a very long object, does that. A host built on the SDK can raise the limit with the `maxBufferSize` parameter of `StdioClientTransport` (for example `64 * 1024 * 1024`). Otherwise, read large objects in parts, for example `get_object` with a `block` subtree.

## Debugging

Set `ANYTYPE_MCP_DEBUG=1` to log each forwarded method with its HTTP status and timing to stderr. Debug logs omit arguments, headers, payloads and tool definitions.
