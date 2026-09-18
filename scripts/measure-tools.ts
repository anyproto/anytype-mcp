import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { OpenAPIV3 } from "openapi-types";
import { OpenAPIToMCPConverter } from "../src/openapi/parser";

const paths = process.argv.slice(2);
if (!paths.length)
  paths.push("src/openapi/__tests__/fixtures/anytype-v1.json", "src/openapi/__tests__/fixtures/anytype-v2.json");

for (const path of paths) {
  const spec = JSON.parse(readFileSync(path, "utf8")) as OpenAPIV3.Document;
  const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools();
  const listed = tools.API.methods.map(({ name, description, inputSchema }) => ({
    name: `API-${name}`,
    description,
    inputSchema,
  }));
  const json = JSON.stringify({ tools: listed });
  console.log(
    JSON.stringify({ spec: path, tools: listed.length, characters: json.length, utf8Bytes: Buffer.byteLength(json) }),
  );
}
