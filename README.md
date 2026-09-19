# Anytype MCP Server

<a href="https://npmjs.org/package/@anyproto/anytype-mcp"><img src="https://img.shields.io/npm/v/@anyproto/anytype-mcp.svg" alt="NPM version" height="20" /></a>
<a href="https://cursor.com/en-US/install-mcp?name=anytype&config=eyJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9LCJjb21tYW5kIjoibnB4IC15IEBhbnlwcm90by9hbnl0eXBlLW1jcCJ9"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add anytype MCP server to Cursor" height="20" /></a>
<a href="https://lmstudio.ai/install-mcp?name=anytype&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbnlwcm90by9hbnl0eXBlLW1jcCJdLCJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9fQ%3D%3D"><img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add MCP Server anytype to LM Studio" height="20" /></a>
<a href="https://kiro.dev/launch/mcp/add?name=anytype&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40anyproto%2Fanytype-mcp%22%5D%2C%22env%22%3A%7B%22OPENAPI_MCP_HEADERS%22%3A%22%7B%5C%22Authorization%5C%22%3A%5C%22Bearer%20%3CYOUR_API_KEY%3E%5C%22%2C%20%5C%22Anytype-Version%5C%22%3A%5C%222025-11-08%5C%22%7D%22%7D%7D"><img src="https://kiro.dev/images/add-to-kiro.svg" alt="Add to Kiro" height="20" /></a>

The Anytype MCP Server is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server enabling AI assistants to seamlessly interact with [Anytype's API](https://github.com/anyproto/anytype-api) through natural language.

It bridges the gap between AI and Anytype's powerful features by converting Anytype's OpenAPI specification into MCP tools, allowing you to manage your knowledge base through conversation.

## Features

- Global & Space Search
- Spaces & Members
- Objects & Lists
- Properties & Tags
- Types & Templates

## Quick Start

### 1. Get Your API Key

1. Open Anytype
2. Go to App Settings
3. Navigate to API Keys section
4. Click on `Create new` button

<details>
<summary>Alternative: Get API key via CLI</summary>

You can also get your API key using the command line:

```bash
npx -y @anyproto/anytype-mcp get-key
```

</details>

### 2. Configure Your MCP Client

#### Claude Desktop, Cursor, Windsurf, Raycast, etc.

Add the following configuration to your MCP client settings after replacing `<YOUR_API_KEY>` with your actual API key:

```json
{
  "mcpServers": {
    "anytype": {
      "command": "npx",
      "args": ["-y", "@anyproto/anytype-mcp"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_API_KEY>\", \"Anytype-Version\":\"2025-11-08\"}"
      }
    }
  }
}
```

> **Tip:** After creating an API key in Anytype, you can copy that ready-to-use configuration snippet with your API key already filled in from the API Keys section.

#### Claude Code (CLI)

Run this command to add the Anytype MCP server after replacing `<YOUR_API_KEY>` with your actual API key:

```bash
claude mcp add anytype -e OPENAPI_MCP_HEADERS='{"Authorization":"Bearer <YOUR_API_KEY>", "Anytype-Version":"2025-11-08"}' -s user -- npx -y @anyproto/anytype-mcp
```

<details>
<summary>Alternative: Global Installation</summary>

If you prefer to install the package globally:

1. Install the package:

```bash
npm install -g @anyproto/anytype-mcp
```

2. Update your MCP client configuration to use the global installation:

```json
{
  "mcpServers": {
    "anytype": {
      "command": "anytype-mcp",
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_API_KEY>\", \"Anytype-Version\":\"2025-11-08\"}"
      }
    }
  }
}
```

</details>

### Custom API Base URL

By default, the server connects to `http://127.0.0.1:31009`. For `anytype-cli` (port `31012`) or other custom base URLs, set `ANYTYPE_API_BASE_URL`:

<details>
<summary>Example Configuration</summary>

**MCP Client (Claude Desktop, Cursor, etc.):**
```json
{
  "mcpServers": {
    "anytype": {
      "command": "npx",
      "args": ["-y", "@anyproto/anytype-mcp"],
      "env": {
        "ANYTYPE_API_BASE_URL": "http://localhost:31012",
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_API_KEY>\", \"Anytype-Version\":\"2025-11-08\"}"
      }
    }
  }
}
```

**Claude Code (CLI):**
```bash
claude mcp add anytype \
  -e ANYTYPE_API_BASE_URL='http://localhost:31012' \
  -e OPENAPI_MCP_HEADERS='{"Authorization":"Bearer <YOUR_API_KEY>", "Anytype-Version":"2025-11-08"}' \
  -s user -- npx -y @anyproto/anytype-mcp
```

</details>

## Example Interactions

Here are some examples of how you can interact with your Anytype:

- "Create a new space called 'Project Ideas' with description 'A space for storing project ideas'"
- "Add a new object of type 'Task' with title 'Research AI trends' to the 'Project Ideas' space"
- "Create a second one with title 'Dive deep into LLMs' with due date in 3 days and assign it to me"
- "Now create a collection with the title "Tasks for this week" and add the two tasks to that list. Set due date of the first one to 10 days from now"

## Tool behavior and API versions

The server loads one OpenAPI document at startup. With the standard configuration it tries `/v2/docs/openapi.json` first. If that endpoint returns 404 or 410, it falls back to `/docs/openapi.json` on the same server, where older apps serve v1. This selects v2 whenever available while supporting apps that only have the legacy API:

```json
"args": ["-y", "@anyproto/anytype-mcp"]
```

To explicitly use the legacy v1 API, select its versioned spec:

```json
"args": ["-y", "@anyproto/anytype-mcp", "run", "http://127.0.0.1:31009/v1/docs/openapi.json"]
```

The versioned `/v2/docs/openapi.json` URL also remains available for explicitly selecting v2.

Explicit spec URLs and local files are used exactly as supplied, without fallback. Authentication failures, server errors, connection failures, and malformed JSON also fail startup instead of selecting another API. The wrapper uses the routes declared in the selected document without rewriting their version prefixes.

Discovery runs once per MCP process. Tool calls reuse the parsed specification and HTTP client without fetching OpenAPI again. Restart the MCP server after updating Anytype to discover a newly available API version; no persistent spec cache is used.

Tool descriptions contain operation guidance; API errors are returned when calls fail, with `isError: true`, HTTP status when available, and the API's code, message, issues, and hints.

The server names its own operations by OpenAPI operationId in the prose it serves. In the MCP tool listing and in the field descriptions of a `get_schema` or `get_op_schema` response, those names are re-spelled as this wrapper's tool names (`list_properties` becomes `API-list-properties`). A repair hint is different: the server spells each operation it names as a REST route and lists it as a typed `see_also` reference, so the wrapper replaces that route text with the tool name and arguments, and annotates the reference with `tool` and `args`. Literal values are never rewritten: enum and example values, `op` names, `endpoint` strings and output schemas keep the server's spelling, and so do the OpenAI and Anthropic tool exports, which name tools by operationId.

Successful v1 object creation, updates, deletion, and chat creation return a compact `object` receipt with its ID, space ID, name, archive state, and type identity when available. The wrapper omits echoed markdown, snippets, property values, icons, and full type definitions. It preserves warnings, generated IDs, and etag/retry metadata. Read the object to retrieve its content when needed. v2 already returns compact create/edit receipts, which are passed through unchanged apart from their warnings, whose hints are re-spelled and whose references gain `tool` and `args`; reads, searches, and errors also keep their full API responses.

The shared tool policy controls inputs and request routing:

- `Authorization` and `Anytype-Version` come from `OPENAPI_MCP_HEADERS`.
- `expected_etag` maps to `If-Match`. Use the etag from a previous read to prevent overwriting a changed object. The wrapper does not retry a failed precondition or remove it. Response etags are returned in a separate `request_metadata` text block when available.
- `request_key` maps to `Idempotency-Key` on endpoints that declare that header. Omit it for a new write; the wrapper generates a unique key and returns it in `request_metadata` or an error's `request_key`. Reuse it only to retry the same write. Separate calls get different generated keys, even with identical documents. There are no automatic retries. A global `Idempotency-Key` in `OPENAPI_MCP_HEADERS` is rejected.
- Existing callers can still use the exact legacy `If-Match` and `Idempotency-Key` argument names. They are not advertised alongside the new names. Conflicting alias values are rejected.
- Pagination, field selection, `dry_run`, `create_missing_options`, and schema discovery remain available.
- Pairing and API-key management are excluded. v2 `auth_whoami` remains available for inspecting the current credential's permissions; its response does not contain the bearer token.
- Event-stream tools are excluded because they do not produce a bounded tool result. Use message-listing tools to retrieve chat messages.
- File downloads are supported through a binary adapter. The tool streams bytes to a private temporary directory and returns `path`, `filename`, `media_type`, and `size`. The path is local to the machine/container running MCP. Successful files remain there until removed or cleaned up by the operating system; interrupted downloads are removed. Range and cache headers are not model inputs.

Known inputs with HTTP meanings are matched by parameter location, so a document's own fields are preserved. Open-ended JSON documents use the `body` argument. Objects with declared fields use flat arguments. The existing omission of flattened `filters` fields and the `FilterExpression` schema fallback remain separate limitations; this cleanup does not restore filter-schema support.

Duplicate final tool names fail startup with both routes identified. Select separate v1/v2 specs instead of merging operations with overlapping names.

Set `ANYTYPE_MCP_DEBUG=1` for concise operation names, response status, and timing on stderr. Arguments, authorization headers, payloads, and entire operation tables are not logged.

### Measuring tool definitions

```bash
bun run measure-tools
# Or inspect a different local OpenAPI document:
bun run measure-tools ./path/to/openapi.json
```

The default command compares fixed v1 and v2 fixtures. It reports tool count, serialized characters, and UTF-8 bytes, not model-specific token counts.

## Development

### Installation from Source

1. Clone the repository:

```bash
git clone https://github.com/anyproto/anytype-mcp.git
cd anytype-mcp
```

2. Install dependencies (requires [Bun](https://bun.com)):

```bash
bun install
```

3. Build the project:

```bash
bun run build
```

4. Link the package globally (optional):

```bash
bun link
```

## Contribution

Thank you for your desire to develop Anytype together!

❤️ This project and everyone involved in it is governed by the [Code of Conduct](https://github.com/anyproto/.github/blob/main/docs/CODE_OF_CONDUCT.md).

🧑‍💻 Check out our [contributing guide](https://github.com/anyproto/.github/blob/main/docs/CONTRIBUTING.md) to learn about asking questions, creating issues, or submitting pull requests.

🫢 For security findings, please email [security@anytype.io](mailto:security@anytype.io) and refer to our [security guide](https://github.com/anyproto/.github/blob/main/docs/SECURITY.md) for more information.

🤝 Follow us on [Github](https://github.com/anyproto) and join the [Contributors Community](https://github.com/orgs/anyproto/discussions).

---

Made by Any — a Swiss association 🇨🇭

Licensed under [MIT](./LICENSE.md).
