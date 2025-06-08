FROM node:22-slim AS build
WORKDIR /app
COPY . ./
RUN npm ci
RUN npm run build
CMD ["node", "bin/cli.mjs"]
