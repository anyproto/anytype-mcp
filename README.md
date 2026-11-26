# Anytype MCP Server

<a href="https://npmjs.org/package/@anyproto/anytype-mcp"><img src="https://img.shields.io/npm/v/@anyproto/anytype-mcp.svg" alt="NPM version" height="20" /></a>
<a href="https://cursor.com/en-US/install-mcp?name=anytype&config=eyJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9LCJjb21tYW5kIjoibnB4IC15IEBhbnlwcm90by9hbnl0eXBlLW1jcCJ9"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add anytype MCP server to Cursor" height="20" /></a>
<a href="https://lmstudio.ai/install-mcp?name=anytype&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbnlwcm90by9hbnl0eXBlLW1jcCJdLCJlbnYiOnsiT1BFTkFQSV9NQ1BfSEVBREVSUyI6IntcIkF1dGhvcml6YXRpb25cIjpcIkJlYXJlciA8WU9VUl9BUElfS0VZPlwiLCBcIkFueXR5cGUtVmVyc2lvblwiOlwiMjAyNS0xMS0wOFwifSJ9fQ%3D%3D"><img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add MCP Server anytype to LM Studio" height="20" /></a>
<a href="https://kiro.dev/launch/mcp/add?name=anytype&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40anyproto%2Fanytype-mcp%22%5D%2C%22env%22%3A%7B%22OPENAPI_MCP_HEADERS%22%3A%22%7B%5C%22Authorization%5C%22%3A%5C%22Bearer%20%3CYOUR_API_KEY%3E%5C%22%2C%20%5C%22Anytype-Version%5C%22%3A%5C%222025-11-08%5C%22%7D%22%7D%7D"><img src="https://kiro.dev/images/add-to-kiro.svg" alt="Add to Kiro" height="20" /></a>

The Anytype MCP Server is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server enabling AI assistants to seamlessly interact with [Anytype's API](https://github.com/anyproto/anytype-api) through natural language.

Anytype serves MCP itself, from its local API at `http://127.0.0.1:31009/mcp/full`. This package connects MCP clients that can only launch a local command (Claude Desktop, for example) to that server: it forwards each message from stdio to Anytype and passes the answer back. The tools come from the Anytype app you run, so they follow its version.

It needs Anytype with heart 0.51.6 or later, the first version with the built-in MCP server. For an older Anytype, pin version 2: `npx -y @anyproto/anytype-mcp@2.0.3`.

## Features

- Global & Space Search
- Spaces & Members
- Objects & Lists
- Properties & Tags
- Types & Templates
- Chats & Files

## Quick Start

You need Node.js 18 or later (for `npx`) and Anytype with heart 0.51.6 or later.

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

See [Tool behavior](docs/tool-behavior.md) for errors, sessions, and troubleshooting.

### Local files

On `full`, two more tools move files between Anytype and the computer running MCP. They use one directory only: `~/.anytype-mcp/files`, created on first use and readable by your user only. Set `ANYTYPE_MCP_FILES_DIR` to an absolute path to use another directory.

- `upload_local_file` uploads a file from that directory. Its `path` is relative to the directory, for example `report.pdf`. Paths outside it are refused, including absolute paths, `..`, and symbolic links that lead out. Named pipes and other special files are refused too. To upload a file, put it in the directory first.
- `download_file` saves a file into that directory under the file's name in Anytype, such as `report.pdf`, or `report (2).pdf` if that name is taken, and returns the path. It never overwrites an existing file. A file appears under its name only once it is complete. This needs a filesystem with hard links; on FAT or exFAT the download fails and nothing is saved.

`upload_file` uploads from a web URL and needs no local directory.

Keep the directory to yourself. The checks resolve the path, then open the file, so someone else who can write inside the directory could swap a folder in between and point an upload at a file outside it. The default directory is created readable by your user only. Do not point `ANYTYPE_MCP_FILES_DIR` at a folder that others or other programs write to.

## Upgrading from 2.x

Version 3 forwards to Anytype's built-in MCP server instead of generating tools from its OpenAPI document. It needs Node.js 18 or later. The configuration stays the same, but the tools change:

- Tool names lose the `API-` prefix and use underscores: `API-list-spaces` is now `list_spaces`, and `API-create-object` is now `create_object`. Update saved prompts, scripts and host permission rules that name tools. In Claude Code, `mcp__anytype__API-list-spaces` becomes `mcp__anytype__list_spaces`.
- `create_object`, `create_type` and `update_type` take their fields as top-level arguments. There is no `body` wrapper any more:

  ```jsonc
  // 2.x: API-create-object
  { "space_id": "…", "body": { "type": "page", "name": "Ideas", "markdown": "First idea" } }
  // 3.x: create_object
  { "space_id": "…", "type": "page", "name": "Ideas", "markdown": "First idea" }
  // 2.x: API-update-type
  { "space_id": "…", "type": "task", "body": { "name": "Tasks" } }
  // 3.x: update_type
  { "space_id": "…", "type": "task", "name": "Tasks" }
  ```

  Other writes may have changed shape the same way. Check `tools/list` for the exact arguments of your saved calls.
- Tool errors are results with `isError: true` whose text is written to be read: Anytype's message, issues and repair hints. The text is not a JSON envelope you can parse for `status` or `code`. Check `isError` first, then treat the text as a message.

- `API-upload-file` took a local `file`. Its replacements are `upload_local_file`, which takes a `path` inside the local files directory (see [Local files](#local-files)), and `upload_file`, which takes a web `url` only.
- `expected_etag` is gone. Object edits through `patch_object` ops are atomic operations, so concurrent edits to different parts of an object no longer overwrite each other. Types are different:
  - `update_type` with `property_definitions` replaces the type's whole field list. To add one field without restating the list, use the `add_property` op, as below.
  - Even its ops rewrite the type's lists on the server, so two concurrent type edits can still undo each other.
  - A batch that mixes property and view ops can fail after its property changes were written. After a failed mixed batch, read the type again before retrying.

  ```jsonc
  // replaces every field of the type with this list
  { "space_id": "…", "type": "task", "property_definitions": [ /* the whole list */ ] }
  // adds one field without restating the others
  { "space_id": "…", "type": "task", "ops": [{ "op": "add_property", /* see get_op_schema */ }] }
  ```

  `if_match` is still accepted on the tools that declare it, `update_type` among them, for callers that hold a value.
- `request_key` is gone. Anytype adds an idempotency key to every write itself. Only `toggle_chat_reaction` takes one, as `idempotency_key`, so a retried toggle does not undo itself. Anytype generates a fresh key for each MCP call, so if a write's reply is lost, check whether the write landed before repeating it; this matters most for `toggle_chat_reaction`, where a repeat undoes the first toggle.
- `API-auth-whoami` and `API-publish-chat-status` are no longer offered.
- `run <openapi-spec>` is gone. The spec chose which server the key went to: its `servers[0].url`. Before removing the spec argument, check where the key should go:
  - If `ANYTYPE_API_BASE_URL` is already set, keep it.
  - Otherwise, open the spec and set `ANYTYPE_API_BASE_URL` to the API origin in its `servers[0].url`. That is typically `http://127.0.0.1:31009`, or `http://127.0.0.1:31012` for anytype-cli.

  Do not use the address the spec was downloaded from, which can be another host. Without the variable, version 3 sends your key to `http://127.0.0.1:31009`. To keep the 2.x behavior instead, for example with an Anytype older than heart 0.51.6, pin version 2 and keep your arguments as they were:

  ```json
  { "args": ["-y", "@anyproto/anytype-mcp@2.0.3", "run", "http://127.0.0.1:31012/v2/docs/openapi.json"] }
  ```

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
