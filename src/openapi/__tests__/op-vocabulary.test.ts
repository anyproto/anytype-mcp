import { describe, expect, it } from "vitest";
import { respellDescriptions, respellOpIds } from "../op-vocabulary";

const vocabulary = {
  list_properties: "API-list-properties",
  get_type: "API-get-type",
  get_type_schema: "API-get-type-schema",
  get_schema: "API-get-schema",
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

  it("re-spells every occurrence, and ids at the edges of the text", () => {
    expect(respellOpIds("get_schema first; then get_schema again", vocabulary)).toBe(
      "API-get-schema first; then API-get-schema again",
    );
  });

  it("takes the longest id first, so get_type does not cut into get_type_schema", () => {
    expect(respellOpIds("read get_type_schema, not get_type", vocabulary)).toBe(
      "read API-get-type-schema, not API-get-type",
    );
  });

  it("leaves an id that is also a plain word alone", () => {
    expect(respellOpIds("validate the document before you search", vocabulary)).toBe(
      "validate the document before you search",
    );
  });

  it("leaves a token that merely contains an id alone", () => {
    expect(respellOpIds("list_properties_v1 and prelist_properties", vocabulary)).toBe(
      "list_properties_v1 and prelist_properties",
    );
    expect(respellOpIds("/v2/schemas/ops/list_properties or ops.list_properties", vocabulary)).toBe(
      "/v2/schemas/ops/list_properties or ops.list_properties",
    );
  });

  it("does not rescan a tool name it just wrote", () => {
    expect(respellOpIds("get_type", { get_type: "API-get_type-again", ...{} })).toBe("API-get_type-again");
  });

  it("ignores Object.prototype names and an empty text", () => {
    expect(respellOpIds("toString is not an op", vocabulary)).toBe("toString is not an op");
    expect(respellOpIds("", vocabulary)).toBe("");
  });
});

describe("respellDescriptions", () => {
  it("rewrites description strings at any depth and nothing else", () => {
    const schema = {
      description: "read get_schema first",
      properties: {
        property: { type: "string", description: "by the key list_properties serves" },
        title: { type: "string", enum: ["list_properties"], default: "list_properties" },
      },
      example: { description: "list_properties" },
    };
    expect(respellDescriptions(schema, vocabulary)).toEqual({
      description: "read API-get-schema first",
      properties: {
        property: { type: "string", description: "by the key API-list-properties serves" },
        title: { type: "string", enum: ["list_properties"], default: "list_properties" },
      },
      example: { description: "API-list-properties" },
    });
  });

  it("returns arrays, primitives and null unchanged in shape", () => {
    expect(respellDescriptions([{ description: "get_schema" }, 1, null], vocabulary)).toEqual([
      { description: "API-get-schema" },
      1,
      null,
    ]);
    expect(respellDescriptions("get_schema", vocabulary)).toBe("get_schema");
  });
});
