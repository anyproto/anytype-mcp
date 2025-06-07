FROM node:22-slim AS build
WORKDIR /app
COPY . ./
RUN npm ci
RUN npm run build
RUN cp scripts/openapi.json dist/
ENV ANYTYPE_API_BUNDLED_SPEC_PATH=/app/dist/openapi.json
CMD ["node", "bin/cli.mjs"]
