# Anytype MCP Server

<a href="https://npmjs.org/package/@anyproto/anytype-mcp"><img src="https://img.shields.io/npm/v/@anyproto/anytype-mcp.svg" alt="NPM version" height="20" /></a>
<a href="https://cursor.com/en-US/install-mcp?name=anytype&config=eyJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9LCJjb21tYW5kIjoibnB4IC15IEBhbnlwcm90by9hbnl0eXBlLW1jcCJ9"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add anytype MCP server to Cursor" height="20" /></a>
<a href="https://lmstudio.ai/install-mcp?name=anytype&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbnlwcm90by9hbnl0eXBlLW1jcCJdLCJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9fQ%3D%3D"><img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add MCP Server anytype to LM Studio" height="20" /></a>
<a href="https://kiro.dev/launch/mcp/add?name=anytype&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40anyproto%2Fanytype-mcp%22%5D%2C%22env%22%3A%7B%22OPENAPI_MCP_HEADERS%22%3A%22%7B%5C%22Authorization%5C%22%3A%5C%22Bearer%20%3CYOUR_API_KEY%3E%5C%22%2C%20%5C%22Anytype-Version%5C%22%3A%5C%222025-11-08%5C%22%7D%22%7D%7D"><img src="https://kiro.dev/images/add-to-kiro.svg" alt="Add to Kiro" height="20" /></a>

The Anytype MCP Server is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server enabling AI assistants to seamlessly interact with [Anytype's API](https://github.com/anyproto/anytype-api) through natural language.

Anytype serves MCP itself, from its local API at `http://127.0.0.1:31009/mcp/full`. This package connects MCP clients that can only launch a local command (Claude Desktop, for example) to that server: it forwards each message from stdio to Anytype and passes the answer back. The tools come from the Anytype app you run, so they follow its version.

## Features

- Global & Space Search
- Spaces & Members
- Objects & Lists
- Properties & Tags
- Types & Templates
- Chats & Files

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

## Tool sets and behavior

Anytype serves three tool sets. `full` (the default) has one tool per API operation, named after it (`list_spaces`, `patch_object`, `add_chat_message`). `small` and `large` are compact task-oriented sets meant for smaller models. Choose one with `--tier` or `ANYTYPE_MCP_TIER`:

```json
{
  "args": ["-y", "@anyproto/anytype-mcp", "--tier", "large"]
}
```

On `full`, two more tools work with files on the computer running MCP: `upload_local_file` uploads a file by its path, and `download_file` saves a file to a private temporary directory and returns its path.

Anytype versions without the built-in MCP server get the tools this package used to generate from Anytype's OpenAPI document instead. Update Anytype to use the built-in server.

See [Tool behavior](docs/tool-behavior.md) for errors, sessions, the generated-tools mode, and troubleshooting.

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
