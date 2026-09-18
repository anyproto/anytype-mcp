import { readFileSync } from "node:fs";
import { URL } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { OpenAPIToMCPConverter } from "../parser";

const v1 = JSON.parse(
  readFileSync(new URL("./fixtures/anytype-v1.json", import.meta.url), "utf8"),
) as OpenAPIV3.Document;
const v2 = JSON.parse(
  readFileSync(new URL("./fixtures/anytype-v2.json", import.meta.url), "utf8"),
) as OpenAPIV3.Document;

describe("fixed Anytype tool manifests", () => {
  it.each([
    { version: "v1", spec: v1, count: 49, maxCharacters: 33500 },
    { version: "v2", spec: v2, count: 46, maxCharacters: 20400 },
  ])("keeps the $version tool list compact and usable", ({ version, spec, count, maxCharacters }) => {
    const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec as OpenAPIV3.Document).convertToMCPTools();
    const listed = tools.API.methods.map(({ name, description, inputSchema }) => ({
      name: `API-${name}`,
      description,
      inputSchema,
    }));
    expect(listed).toHaveLength(count);
    expect(JSON.stringify({ tools: listed }).length).toBeLessThanOrEqual(maxCharacters);
    expect(new Set(listed.map((tool) => tool.name)).size).toBe(count);
    for (const tool of listed) {
      expect(tool.description).not.toContain("Error Responses:");
      expect(openApiLookup[tool.name].path).toMatch(new RegExp(`^/${version}/`));
      expect(tool.inputSchema).not.toHaveProperty("$defs", {});
      for (const hidden of [
        "Authorization",
        "Anytype-Version",
        "Idempotency-Key",
        "If-Match",
        "Range",
        "If-None-Match",
        "If-Range",
        "Last-Event-ID",
      ]) {
        expect(tool.inputSchema.properties).not.toHaveProperty(hidden);
      }
    }
    const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool]));
    expect(byName).toHaveProperty("API-download-file");
    expect(byName).toHaveProperty("API-upload-file");
    expect(byName).toHaveProperty("API-get-chat-messages");
    expect(byName).not.toHaveProperty("API-chat-message-stream");
    expect(byName).not.toHaveProperty("API-stream-chat-messages");
    expect(byName).not.toHaveProperty("API-create-api-key");
    expect(byName).not.toHaveProperty("API-create-auth-challenge");
    if (version === "v2") {
      expect(byName).toHaveProperty("API-auth-whoami");
      expect(byName).toHaveProperty("API-get-op-schema");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("body");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("dry_run");
      expect(byName["API-create-type"].inputSchema.properties).toHaveProperty("create_missing_options");
      expect(byName["API-patch-object"].inputSchema.properties).toHaveProperty("expected_etag");
      expect(byName["API-create-space"].inputSchema.properties).toHaveProperty("request_key");
      expect(byName["API-list-objects"].inputSchema.properties).toHaveProperty("fields");
    }
  });
});
