import { describe, expect, it } from "vitest";
import { respellOpIds, respellSchemaDescriptions } from "../op-vocabulary";

const vocabulary = {
  list_properties: "API-list-properties",
  get_type: "API-get-type",
  get_type_schema: "API-get-type-schema",
  get_schema: "API-get-schema",
  Get_Schema_v2: "API-Get-Schema-v2",
  validate: "API-validate",
  search: "API-search",
  toString: "API-to-string",
};

describe("respellOpIds", () => {
  it("re-spells an op id as the tool that runs it", () => {
    expect(respellOpIds("the property, by the key list_properties serves or by its display name", vocabulary)).toBe(
      "the property, by the key API-list-properties serves or by its display name",
    );
  });

  it("re-spells every occurrence, at the edges of the text and before sentence punctuation", () => {
    expect(respellOpIds("get_schema first; then get_schema again. Use get_schema.", vocabulary)).toBe(
      "API-get-schema first; then API-get-schema again. Use API-get-schema.",
    );
    expect(respellOpIds("(get_schema), get_schema: yes", vocabulary)).toBe("(API-get-schema), API-get-schema: yes");
  });

  it("takes the longest id first", () => {
    expect(respellOpIds("read get_type_schema, not get_type", vocabulary)).toBe(
      "read API-get-type-schema, not API-get-type",
    );
  });

  it("leaves an id that is also a plain word alone", () => {
    expect(respellOpIds("validate the document before you search", vocabulary)).toBe(
      "validate the document before you search",
    );
  });

  it("leaves a token that merely contains an id alone, in any script", () => {
    expect(respellOpIds("list_properties_v1 and prelist_properties and get_schemaé", vocabulary)).toBe(
      "list_properties_v1 and prelist_properties and get_schemaé",
    );
    expect(respellOpIds("/v2/schemas/ops/list_properties or ops.list_properties or get_schema.json", vocabulary)).toBe(
      "/v2/schemas/ops/list_properties or ops.list_properties or get_schema.json",
    );
  });

  it("replaces in one pass: a tool name it just wrote is not rescanned", () => {
    // get_type's tool name is itself another op id; a second pass would turn it into that op's tool
    expect(respellOpIds("get_type get_schema", { get_type: "get_schema", get_schema: "API-get-schema" })).toBe(
      "get_schema API-get-schema",
    );
  });

  it("accepts an id in any case, and escapes it", () => {
    expect(respellOpIds("see Get_Schema_v2", vocabulary)).toBe("see API-Get-Schema-v2");
    // an unescaped dot would also match axb_c
    expect(respellOpIds("see a.b_c and axb_c", { "a.b_c": "API-x" })).toBe("see API-x and axb_c");
  });

  it("ignores Object.prototype names and an empty text", () => {
    expect(respellOpIds("toString is not an op", vocabulary)).toBe("toString is not an op");
    expect(respellOpIds("", vocabulary)).toBe("");
  });
});

describe("respellSchemaDescriptions", () => {
  it("rewrites descriptions along the schema keywords, at any depth", () => {
    const schema = {
      description: "read get_schema first",
      properties: {
        property: { type: "string", description: "by the key list_properties serves" },
        nested: {
          anyOf: [{ items: { description: "get_schema" } }, { additionalProperties: { description: "get_type" } }],
          if: { description: "get_schema" },
          then: { description: "get_schema" },
        },
      },
      $defs: { node: { oneOf: [{ description: "list_properties" }] } },
    };
    expect(respellSchemaDescriptions(schema, vocabulary)).toEqual({
      description: "read API-get-schema first",
      properties: {
        property: { type: "string", description: "by the key API-list-properties serves" },
        nested: {
          anyOf: [
            { items: { description: "API-get-schema" } },
            { additionalProperties: { description: "API-get-type" } },
          ],
          if: { description: "API-get-schema" },
          then: { description: "API-get-schema" },
        },
      },
      $defs: { node: { oneOf: [{ description: "API-list-properties" }] } },
    });
  });

  it("follows every schema-bearing keyword", () => {
    const at = (value: unknown) => ({ description: "get_schema", ...(value as object) });
    const schema = {
      patternProperties: { "^x": at({}) },
      dependentSchemas: { a: at({}) },
      dependencies: { a: at({}), b: ["c"] },
      definitions: { d: at({}) },
      prefixItems: [at({})],
      items: [at({})],
      contains: at({}),
      unevaluatedProperties: at({}),
      propertyNames: at({}),
      contentSchema: at({}),
      not: at({}),
      else: at({}),
    };
    const text = JSON.stringify(respellSchemaDescriptions(schema, vocabulary));
    expect(text).not.toContain('"get_schema"');
    expect((text.match(/API-get-schema/g) ?? []).length).toBe(12);
    expect(text).toContain('"b":["c"]');
  });

  it("leaves literal payloads alone: enum, const, default, examples and unknown keywords", () => {
    const schema = {
      properties: {
        title: {
          type: "string",
          enum: [{ description: "list_properties" }, "get_schema"],
          const: { description: "get_schema" },
          default: { description: "get_schema" },
          example: { description: "get_schema" },
          examples: [{ description: "get_schema" }],
          "x-note": { description: "get_schema" },
        },
      },
    };
    expect(respellSchemaDescriptions(schema, vocabulary)).toEqual(schema);
  });

  it("keeps a member literally named __proto__ as an own property", () => {
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"string","description":"get_schema"}}}');
    const out = respellSchemaDescriptions(schema, vocabulary) as { properties: Record<string, unknown> };
    expect(Object.hasOwn(out.properties, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).toBe('{"properties":{"__proto__":{"type":"string","description":"API-get-schema"}}}');
  });

  it("rewrites a shared subschema once and survives a cycle", () => {
    const shared = { description: "get_schema" };
    const cyclic: Record<string, unknown> = { description: "get_type" };
    cyclic.items = cyclic;
    const out = respellSchemaDescriptions(
      { properties: { a: shared, b: shared, c: cyclic } },
      vocabulary,
    ) as unknown as {
      properties: Record<string, { description: string; items?: unknown }>;
    };
    expect(out.properties.a.description).toBe("API-get-schema");
    expect(out.properties.b).toBe(out.properties.a);
    expect(out.properties.c.description).toBe("API-get-type");
    expect(out.properties.c.items).toBe(cyclic);
  });

  it("returns non-schemas unchanged", () => {
    expect(respellSchemaDescriptions([{ description: "get_schema" }], vocabulary)).toEqual([
      { description: "get_schema" },
    ]);
    expect(respellSchemaDescriptions("get_schema", vocabulary)).toBe("get_schema");
    expect(respellSchemaDescriptions(true, vocabulary)).toBe(true);
  });
});
