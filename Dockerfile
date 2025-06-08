FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY . .

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --omit-dev && \
    npm run build && \
    npm link

FROM node:22-slim

COPY scripts/openapi.json /usr/local/scripts/
COPY --from=builder /usr/local/lib/node_modules/@anyproto/anytype-mcp /usr/local/lib/node_modules/@anyproto/anytype-mcp
COPY --from=builder /usr/local/bin/anytype-mcp /usr/local/bin/anytype-mcp

ENV OPENAPI_MCP_HEADERS="{}"

ENTRYPOINT ["anytype-mcp"]
