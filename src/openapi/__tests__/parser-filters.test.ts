import { readFileSync } from "fs";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { OpenAPIToMCPConverter } from "../parser";

// Regression tests for the flattened `FilterExpression` schema (PR #32).
//
// The real Anytype spec models `filters` as a recursive `FilterExpression`
// whose `conditions` are a 12-variant `oneOf` (`FilterItem`). We flatten that
// into a single agent-friendly object. These tests pin that flattening against
// the checked-in spec so it can't silently regress back to `{}` or drop fields.

const SPEC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/openapi.json");

// The full set of value fields, one per `FilterItem` variant in the spec.
const VALUE_FIELDS: Record<string, "string" | "number" | "boolean" | "array"> = {
  text: "string",
  number: "number",
  checkbox: "boolean",
  date: "string",
  select: "string",
  multi_select: "array",
  objects: "array",
  files: "array",
  url: "string",
  email: "string",
  phone: "string",
};

// Short-form condition enum the API actually accepts (see FilterCondition
// x-enum-varnames). All 13 must be exposed.
const EXPECTED_CONDITIONS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "nempty",
  "in",
  "nin",
  "contains",
  "ncontains",
  "all",
];

describe("FilterExpression flattening", () => {
  let filtersBySearchTool: Record<string, IJsonSchema>;

  beforeAll(() => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, "utf-8")) as OpenAPIV3.Document;
    const converter = new OpenAPIToMCPConverter(spec);
    const { tools } = converter.convertToMCPTools();

    const methods = Object.values(tools).flatMap((tool) => tool.methods);
    filtersBySearchTool = {};
    for (const name of ["search-space", "search-global"]) {
      const method = methods.find((m) => m.name === name);
      expect(method, `tool ${name} should exist`).toBeDefined();
      filtersBySearchTool[name] = (method!.inputSchema as IJsonSchema).properties!.filters as IJsonSchema;
    }
  });

  it("registers both search tools", () => {
    expect(Object.keys(filtersBySearchTool).sort()).toEqual(["search-global", "search-space"]);
  });

  for (const toolName of ["search-space", "search-global"]) {
    describe(toolName, () => {
      it("exposes a flattened filters object (not an empty {} or a $ref)", () => {
        const filters = filtersBySearchTool[toolName];
        expect(filters).toBeDefined();
        expect(filters.$ref).toBeUndefined();
        expect(filters.type).toBe("object");
        expect(filters.properties).toBeDefined();
        expect(Object.keys(filters.properties!)).toEqual(expect.arrayContaining(["operator", "conditions", "filters"]));
      });

      it("exposes the and/or operator enum", () => {
        const operator = filtersBySearchTool[toolName].properties!.operator as IJsonSchema;
        expect(operator.type).toBe("string");
        expect(operator.enum).toEqual(["and", "or"]);
      });

      it("exposes the full condition enum", () => {
        const item = (filtersBySearchTool[toolName].properties!.conditions as IJsonSchema).items as IJsonSchema;
        const condition = item.properties!.condition as IJsonSchema;
        expect(condition.enum).toEqual(EXPECTED_CONDITIONS);
      });

      it("requires property_key and condition on each item", () => {
        const item = (filtersBySearchTool[toolName].properties!.conditions as IJsonSchema).items as IJsonSchema;
        expect(item.required).toEqual(["property_key", "condition"]);
        expect((item.properties!.property_key as IJsonSchema).type).toBe("string");
      });

      it("exposes every type-specific value field", () => {
        const item = (filtersBySearchTool[toolName].properties!.conditions as IJsonSchema).items as IJsonSchema;
        for (const [field, type] of Object.entries(VALUE_FIELDS)) {
          const prop = item.properties![field] as IJsonSchema;
          expect(prop, `value field ${field} should exist`).toBeDefined();
          expect(prop.type, `value field ${field} type`).toBe(type);
          if (type === "array") {
            expect((prop.items as IJsonSchema).type, `value field ${field} items`).toBe("string");
          }
        }
      });

      it("supports nested filter expressions", () => {
        const nested = filtersBySearchTool[toolName].properties!.filters as IJsonSchema;
        expect(nested.type).toBe("array");
        expect((nested.items as IJsonSchema).type).toBe("object");
      });
    });
  }
});
