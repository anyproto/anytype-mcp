FROM node:22-slim AS build
WORKDIR /app
COPY . ./
RUN npm ci
RUN npm run build
ENV ANYTYPE_API_SPEC_FILE_PATH=/app/scripts/openapi.json
CMD ["node", "bin/cli.mjs"]
