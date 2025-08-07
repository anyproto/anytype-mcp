# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `npm install -D` - Install all dependencies including devDependencies
- `npm run dev` - Start the development server with file watching (uses tsx watch)
- `npm run build` - Build the TypeScript project and generate CLI binary (bin/cli.mjs)

### Testing
- `npm test` - Run all tests once with Vitest
- `npm run test:dev` - Run tests in watch mode
- Run a specific test file: `npx vitest run src/openapi/__tests__/parser.test.ts`

### Code Quality
- `npm run lint` - Check code formatting with ESLint
- `npm run lint:fix` - Auto-fix formatting issues with ESLint
- `npm run format` - Auto-fix formatting issues with Prettier
- `npm run typecheck` - Run TypeScript type checking without emitting files

### Utility Scripts
- `npm run parse-openapi` - Parse OpenAPI specification

## Architecture Overview

This is an MCP (Model Context Protocol) server that bridges Anytype's API with AI assistants. The architecture follows a proxy pattern where OpenAPI specifications are dynamically converted to MCP tools.

### Core Components

**MCP Proxy Layer (`src/mcp/proxy.ts`)**
- Central orchestrator that implements the MCP server protocol
- Converts OpenAPI operations to MCP tools dynamically at runtime
- Handles tool listing and execution through the MCP protocol
- Maintains a lookup table mapping MCP tool names to OpenAPI operations

**OpenAPI Parser (`src/openapi/parser.ts`)**
- Converts OpenAPI schemas to JSON Schema format for MCP compatibility
- Handles $ref resolution with cycle detection
- Supports multipart/form-data for file uploads
- Generates MCP tool definitions from OpenAPI paths and operations

**HTTP Client (`src/client/http-client.ts`)**
- Built on openapi-client-axios for OpenAPI-aware HTTP requests
- Handles authentication headers from environment variables
- Supports file uploads via FormData
- Executes OpenAPI operations with proper parameter mapping

**Server Initialization (`src/init-server.ts`)**
- Loads OpenAPI spec from URL (default: local Anytype API) or file
- Initializes the MCP proxy with the spec
- Connects to stdio transport for communication

### Key Design Patterns

1. **Dynamic Tool Generation**: Tools are not hardcoded but generated from the OpenAPI spec at runtime, making the server adaptable to API changes.

2. **Header Injection**: Authentication and version headers are parsed from `OPENAPI_MCP_HEADERS` environment variable and injected into all requests.

3. **Operation Mapping**: Each OpenAPI operation becomes an MCP tool with a naming convention: `{tag}-{operationId}`.

4. **Schema Caching**: The parser maintains a cache of resolved schemas to handle circular references and improve performance.

## Testing Strategy

Tests use Vitest and are colocated with source files in `__tests__` directories. Key test areas:
- OpenAPI to MCP conversion logic
- HTTP client behavior including file uploads
- MCP proxy tool execution
- Multipart form data handling

## Code Style

- Prettier with 120 character line width
- Double quotes for strings
- Automatic import organization via prettier-plugin-organize-imports
- TypeScript strict mode enabled
