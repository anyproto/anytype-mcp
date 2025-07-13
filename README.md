# Anytype MCP Server

<a href="https://npmjs.org/package/@anyproto/anytype-mcp"><img src="https://img.shields.io/npm/v/@anyproto/anytype-mcp.svg" alt="NPM version" height="20" /></a>
<a href="https://cursor.com/install-mcp?name=anytype&config=JTdCJTIyY29tbWFuZCUyMiUzQSUyMm5weCUyMC15JTIwJTQwYW55cHJvdG8lMkZhbnl0eXBlLW1jcCUyMiUyQyUyMmVudiUyMiUzQSU3QiUyMk9QRU5BUElfTUNQX0hFQURFUlMlMjIlM0ElMjIlN0IlNUMlMjJBdXRob3JpemF0aW9uJTVDJTIyJTNBJTVDJTIyQmVhcmVyJTIwJTNDWU9VUl9BUElfS0VZJTNFJTVDJTIyJTJDJTIwJTVDJTIyQW55dHlwZS1WZXJzaW9uJTVDJTIyJTNBJTVDJTIyMjAyNS0wNS0yMCU1QyUyMiU3RCUyMiU3RCU3RA%3D%3D"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add anytype MCP server to Cursor" height="20" /></a>
<a href="https://lmstudio.ai/install-mcp?name=anytype&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbnlwcm90by9hbnl0eXBlLW1jcCJdLCJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0wNS0yMFwifSJ9fQ%3D%3D"><img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add MCP Server anytype to LM Studio" height="20" /></a>

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
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_API_KEY>\", \"Anytype-Version\":\"2025-05-20\"}"
      }
    }
  }
}
```

> **Tip:** After creating an API key in Anytype, you can copy that ready-to-use configuration snippet with your API key already filled in from the API Keys section.

#### Claude Code (CLI)

Run this command to add the Anytype MCP server after replacing `<YOUR_API_KEY>` with your actual API key:

```bash
claude mcp add anytype -e OPENAPI_MCP_HEADERS='{"Authorization":"Bearer <YOUR_API_KEY>", "Anytype-Version":"2025-05-20"}' -s user -- npx -y @anyproto/anytype-mcp
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
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_API_KEY>\", \"Anytype-Version\":\"2025-05-20\"}"
      }
    }
  }
}
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

## Contribution

Thank you for your desire to develop Anytype together!

❤️ This project and everyone involved in it is governed by the [Code of Conduct](https://github.com/anyproto/.github/blob/main/docs/CODE_OF_CONDUCT.md).

🧑‍💻 Check out our [contributing guide](https://github.com/anyproto/.github/blob/main/docs/CONTRIBUTING.md) to learn about asking questions, creating issues, or submitting pull requests.

🫢 For security findings, please email [security@anytype.io](mailto:security@anytype.io) and refer to our [security guide](https://github.com/anyproto/.github/blob/main/docs/SECURITY.md) for more information.

🤝 Follow us on [Github](https://github.com/anyproto) and join the [Contributors Community](https://github.com/orgs/anyproto/discussions).

---

Made by Any — a Swiss association 🇨🇭

Licensed under [MIT](./LICENSE.md).
