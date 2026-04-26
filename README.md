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

## Environment Variables

| Variable                  | Default                         | Description                                                                                                                                                                         |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAPI_MCP_HEADERS`     | —                               | JSON object of headers forwarded to the Anytype API on every request. Required for auth: `{"Authorization":"Bearer <key>", "Anytype-Version":"2025-11-08"}`                         |
| `ANYTYPE_API_BASE_URL`    | `http://127.0.0.1:31009`        | Anytype API base URL. Set to `http://localhost:31012` for `anytype-cli`.                                                                                                            |
| `MCP_TRANSPORT`           | `stdio`                         | Transport mode. Set to `http` to enable the Streamable HTTP server.                                                                                                                 |
| `MCP_HOST`                | `127.0.0.1`                     | Host to bind when `MCP_TRANSPORT=http`.                                                                                                                                             |
| `MCP_PORT`                | `3666`                          | Port to listen on when `MCP_TRANSPORT=http`. Must be in range 1024–65535.                                                                                                           |
| `MCP_PASSTHROUGH_HEADERS` | `authorization,anytype-version` | Comma-separated list of inbound HTTP header names (lowercase) forwarded from the MCP HTTP client to the Anytype API. Extend with caution — arbitrary headers must not be forwarded. |

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

## Development

### Installation from Source

1. Clone the repository:

```bash
git clone https://github.com/anyproto/anytype-mcp.git
cd anytype-mcp
```

2. Install dependencies:

```bash
npm install -D
```

3. Build the project:

```bash
npm run build
```

4. Link the package globally (optional):

```bash
npm link
```

### Running in HTTP Transport Mode

Useful for browser-based clients such as [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
MCP_TRANSPORT=http MCP_HOST=127.0.0.1 MCP_PORT=3666 npm run dev
```

Then connect your MCP client to `http://127.0.0.1:3666/mcp`.

Auth is passed through from the MCP client — set `Authorization: Bearer <YOUR_API_KEY>` and `Anytype-Version: 2025-11-08` in your client's request headers. Alternatively, set `OPENAPI_MCP_HEADERS` as with stdio mode.

## Contribution

Thank you for your desire to develop Anytype together!

❤️ This project and everyone involved in it is governed by the [Code of Conduct](https://github.com/anyproto/.github/blob/main/docs/CODE_OF_CONDUCT.md).

🧑‍💻 Check out our [contributing guide](https://github.com/anyproto/.github/blob/main/docs/CONTRIBUTING.md) to learn about asking questions, creating issues, or submitting pull requests.

🫢 For security findings, please email [security@anytype.io](mailto:security@anytype.io) and refer to our [security guide](https://github.com/anyproto/.github/blob/main/docs/SECURITY.md) for more information.

🤝 Follow us on [Github](https://github.com/anyproto) and join the [Contributors Community](https://github.com/orgs/anyproto/discussions).

---

Made by Any — a Swiss association 🇨🇭

Licensed under [MIT](./LICENSE.md).