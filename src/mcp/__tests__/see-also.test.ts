import { describe, expect, it } from "vitest";
import {
  buildOperationIndex,
  respellIssue,
  respellResponse,
  restSpelling,
  servesJsonEnvelope,
  toolSpelling,
  type OperationIndex,
} from "../see-also";

// the shape convertToMCPTools' openApiLookup has: tool name → operation
const lookup: Parameters<typeof buildOperationIndex>[0] = {
  "API-list-spaces": { operationId: "list_spaces", method: "get", path: "/v2/spaces", responses: {} },
  "API-list-properties": {
    operationId: "list_properties",
    method: "get",
    path: "/v2/spaces/{space_id}/properties",
    responses: {},
  },
  "API-delete-property": {
    operationId: "delete_property",
    method: "delete",
    path: "/v2/spaces/{space_id}/properties/{key}",
    responses: {},
  },
  "API-get-object": {
    operationId: "get_object",
    method: "get",
    path: "/v2/spaces/{space_id}/objects/{object_id}",
    parameters: [
      { name: "space_id", in: "path", required: true, schema: { type: "string" } },
      { name: "object_id", in: "path", required: true, schema: { type: "string" } },
      { name: "outline", in: "query", schema: { type: "boolean" } },
      { name: "ids", in: "query", schema: { type: "string" } },
    ],
    responses: {},
  },
  "API-list-objects": {
    operationId: "list_objects",
    method: "get",
    path: "/v2/spaces/{space_id}/objects",
    parameters: [
      { name: "space_id", in: "path", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ],
    responses: {},
  },
  "API-create-object": {
    operationId: "create_object",
    method: "post",
    path: "/v2/spaces/{space_id}/objects",
    parameters: [
      { name: "space_id", in: "path", required: true, schema: { type: "string" } },
      { name: "create_missing_options", in: "query", schema: { type: "boolean" } },
    ],
    responses: {},
  },
  "API-get-op-schema": { operationId: "get_op_schema", method: "get", path: "/v2/schemas/ops/{op}", responses: {} },
};

const index: OperationIndex = buildOperationIndex(lookup);

describe("see_also references", () => {
  describe("restSpelling mirrors the server's rendering", () => {
    // these are the Go Ref.String cases (core/api/v2/model/ref_test.go), verbatim
    it.each([
      ["bare op", { op: "list_spaces" }, "GET /v2/spaces"],
      [
        "bound params, dotted id intact",
        { op: "list_properties", params: { space_id: "sp1.abc" } },
        "GET /v2/spaces/sp1.abc/properties",
      ],
      [
        "unbound param keeps its placeholder",
        { op: "delete_property", params: { space_id: "sp1" } },
        "DELETE /v2/spaces/sp1/properties/{key}",
      ],
      [
        "query",
        { op: "get_object", params: { space_id: "sp1", object_id: "o1" }, query: { outline: "true" } },
        "GET /v2/spaces/sp1/objects/o1?outline=true",
      ],
      ["resend", { query: { create_missing_options: "true" } }, "?create_missing_options=true"],
      ["query keys sorted", { op: "list_spaces", query: { limit: "5", after: "x" } }, "GET /v2/spaces?after=x&limit=5"],
    ])("%s", (_name, ref, want) => {
      expect(restSpelling(ref, index)).toBe(want);
    });
  });

  describe("toolSpelling names this server's tool", () => {
    it("bound parameters become arguments", () => {
      expect(toolSpelling({ op: "get_op_schema", params: { op: "set_properties" } }, index)).toBe(
        'API-get-op-schema {"op":"set_properties"}',
      );
    });

    it("a bound path value is typed by its declared parameter type", () => {
      const typed = buildOperationIndex({
        "API-get-thing": {
          operationId: "get_thing",
          method: "get",
          path: "/v2/things/{item}",
          parameters: [{ name: "item", in: "path", required: true, schema: { type: "integer" } }],
          responses: {},
        },
      });
      expect(toolSpelling({ op: "get_thing", params: { item: "42" } }, typed)).toBe('API-get-thing {"item":42}');
      expect(toolSpelling({ op: "get_thing" }, typed)).toBe('API-get-thing {"item":"<item>"}');
    });

    it("an unbound parameter is a placeholder the caller fills", () => {
      expect(toolSpelling({ op: "delete_property", params: { space_id: "sp1" } }, index)).toBe(
        'API-delete-property {"space_id":"sp1","key":"<key>"}',
      );
    });

    it("a query flag is typed by the operation's declared parameter type", () => {
      expect(
        toolSpelling({ op: "get_object", params: { space_id: "sp1", object_id: "o1" }, query: { outline: "true" } }, index),
      ).toBe('API-get-object {"space_id":"sp1","object_id":"o1","outline":true}');
      expect(toolSpelling({ op: "list_objects", params: { space_id: "s" }, query: { limit: "5" } }, index)).toBe(
        'API-list-objects {"space_id":"s","limit":5}',
      );
      // a string parameter that happens to spell a boolean stays a string
      expect(toolSpelling({ op: "get_object", params: { space_id: "s", object_id: "o" }, query: { ids: "false" } }, index)).toBe(
        'API-get-object {"space_id":"s","object_id":"o","ids":"false"}',
      );
    });

    it("a resend is the extra arguments alone, typed by the operation that produced the issue", () => {
      expect(toolSpelling({ query: { create_missing_options: "true" } }, index, "create_object")).toBe(
        '{"create_missing_options":true}',
      );
      // without a known current operation the value stays as served
      expect(toolSpelling({ query: { create_missing_options: "true" } }, index)).toBe(
        '{"create_missing_options":"true"}',
      );
    });

    it("an op id that names an Object.prototype member is unknown, not a tool", () => {
      expect(toolSpelling({ op: "toString" }, index)).toBeUndefined();
      expect(() => respellIssue({ message: "m", see_also: [{ op: "toString" }] }, {})).not.toThrow();
    });

    it("an operation this spec does not have renders as nothing", () => {
      expect(toolSpelling({ op: "list_members", params: { space_id: "sp1" } }, index)).toBeUndefined();
    });
  });

  describe("respellIssue", () => {
    it("replaces the REST rendering in the hint and annotates the reference", () => {
      const issue = {
        path: "ops[0]",
        message: "invalid set_properties op",
        hint: "GET /v2/schemas/ops/set_properties for the op's schema and example",
        see_also: [{ op: "get_op_schema", params: { op: "set_properties" } }],
      };

      expect(respellIssue(issue, index)).toEqual({
        path: "ops[0]",
        message: "invalid set_properties op",
        hint: `API-get-op-schema {"op":"set_properties"} for the op's schema and example`,
        see_also: [
          {
            op: "get_op_schema",
            params: { op: "set_properties" },
            tool: "API-get-op-schema",
            args: { op: "set_properties" },
          },
        ],
      });
    });

    it("replaces the longer rendering first, so the outline read is not cut into a plain read", () => {
      const issue = {
        message: "m",
        hint: "read with GET /v2/spaces/s/objects/o and copy; GET /v2/spaces/s/objects/o?outline=true truncates",
        see_also: [
          { op: "get_object", params: { space_id: "s", object_id: "o" } },
          { op: "get_object", params: { space_id: "s", object_id: "o" }, query: { outline: "true" } },
        ],
      };

      expect(respellIssue(issue, index).hint).toBe(
        'read with API-get-object {"space_id":"s","object_id":"o"} and copy; API-get-object {"space_id":"s","object_id":"o","outline":true} truncates',
      );
    });

    it("leaves the prose alone for an operation this spec does not have", () => {
      const issue = {
        message: "m",
        hint: "list members with GET /v2/spaces/s/members instead",
        see_also: [{ op: "list_members", params: { space_id: "s" } }],
      };

      const out = respellIssue(issue, index);
      expect(out.hint).toBe("list members with GET /v2/spaces/s/members instead");
      expect(out.see_also?.[0]).toEqual({ op: "list_members", params: { space_id: "s" } });
    });

    it("is a no-op without references", () => {
      const issue = { message: "m", hint: "drop the id" };
      expect(respellIssue(issue, index)).toBe(issue);
    });

    it("replaces in one pass: a bound value that spells another reference is not rewritten again", () => {
      // the object id is itself the resend rendering; it lands verbatim
      // inside the inserted JSON, which a rescan would then corrupt
      const issue = {
        message: "m",
        hint: "read GET /v2/spaces/s/objects/?create_missing_options=true, or resend with ?create_missing_options=true",
        see_also: [
          { op: "get_object", params: { space_id: "s", object_id: "?create_missing_options=true" } },
          { query: { create_missing_options: "true" } },
        ],
      };
      const out = respellIssue(issue, index, "create_object");
      expect(out.hint).toBe(
        'read API-get-object {"space_id":"s","object_id":"?create_missing_options=true"}, or resend with {"create_missing_options":true}',
      );
    });

    it("a bound value that looks like a placeholder is opaque", () => {
      expect(restSpelling({ op: "delete_property", params: { space_id: "s", key: "{space_id}" } }, index)).toBe(
        "DELETE /v2/spaces/s/properties/{space_id}",
      );
    });

    it("leaves the message alone even when it quotes a route rendering", () => {
      const issue = {
        message: 'property "GET /v2/spaces/s/properties" has no option',
        hint: "list them with GET /v2/spaces/s/properties",
        see_also: [{ op: "list_properties", params: { space_id: "s" } }],
      };
      const out = respellIssue(issue, index);
      expect(out.message).toBe(issue.message);
      expect(out.hint).toBe('list them with API-list-properties {"space_id":"s"}');
    });

    it("never throws on a malformed reference list, and passes it through", () => {
      const refs = [null, 1, "s", [], { op: 3 as unknown as string }];
      const issue = { message: "m", hint: "x", see_also: refs };
      const out = respellIssue(issue as never, index);
      expect(out.hint).toBe("x");
      expect(out.see_also).toEqual(refs);
    });
  });

  describe("parameter types through $ref", () => {
    const components = {
      parameters: { Limit: { name: "limit", in: "query", schema: { $ref: "#/components/schemas/Limit" } } },
      schemas: { Limit: { type: "integer" } },
    } as const;
    const refIndex = buildOperationIndex(
      {
        "API-list-things": {
          operationId: "list_things",
          method: "get",
          path: "/v2/things",
          parameters: [{ $ref: "#/components/parameters/Limit" }],
          responses: {},
        },
      },
      components as never,
    );

    it("types a referenced parameter with a referenced schema like the tool converter does", () => {
      expect(toolSpelling({ query: { limit: "25" } }, refIndex, "list_things")).toBe('{"limit":25}');
    });

    it("follows a chain of schema references, and a cycle types as a string", () => {
      const chained = buildOperationIndex(
        {
          "API-list-things": {
            operationId: "list_things",
            method: "get",
            path: "/v2/things",
            parameters: [
              { name: "limit", in: "query", schema: { $ref: "#/components/schemas/LimitAlias" } },
              { name: "loop", in: "query", schema: { $ref: "#/components/schemas/Loop" } },
            ],
            responses: {},
          },
        },
        {
          schemas: { LimitAlias: { $ref: "#/components/schemas/Limit" }, Limit: { type: "integer" }, Loop: { $ref: "#/components/schemas/Loop" } },
        } as never,
      );
      expect(toolSpelling({ query: { limit: "25", loop: "1" } }, chained, "list_things")).toBe('{"limit":25,"loop":"1"}');
    });
  });

  describe("servesJsonEnvelope", () => {
    it("is true for a JSON response, absent content, or absent responses", () => {
      expect(servesJsonEnvelope({ responses: { "200": { description: "ok", content: { "application/json": {} } } } })).toBe(true);
      expect(servesJsonEnvelope({ responses: { "200": { description: "ok" } } })).toBe(true);
      expect(servesJsonEnvelope({ responses: {} })).toBe(true);
    });

    it("is false for a download", () => {
      expect(
        servesJsonEnvelope({ responses: { "200": { description: "bytes", content: { "application/octet-stream": {} } } } }),
      ).toBe(false);
    });

    it("resolves a referenced response and uses the actual status", () => {
      const components = {
        responses: { Download: { description: "bytes", content: { "application/octet-stream": {} } } },
      } as never;
      const operation = {
        responses: {
          "200": { $ref: "#/components/responses/Download" },
          "206": { description: "json", content: { "application/json": {} } },
        },
      };
      expect(servesJsonEnvelope(operation, 200, components)).toBe(false);
      expect(servesJsonEnvelope(operation, 206, components)).toBe(true);
      expect(servesJsonEnvelope(operation, undefined, components)).toBe(false);
    });

    it("a known status falls back to default, never to another status's declaration", () => {
      const operation = {
        responses: {
          "200": { description: "json", content: { "application/json": {} } },
          default: { description: "bytes", content: { "application/octet-stream": {} } },
        },
      };
      expect(servesJsonEnvelope(operation, 206)).toBe(false);
      expect(servesJsonEnvelope(operation, 200)).toBe(true);
    });

    it("honours a 2XX range declaration", () => {
      const operation = { responses: { "2XX": { description: "bytes", content: { "application/octet-stream": {} } } } };
      expect(servesJsonEnvelope(operation, 200)).toBe(false);
      expect(servesJsonEnvelope(operation)).toBe(false);
    });
  });

  describe("respellResponse", () => {
    it("rewrites an error envelope's issues", () => {
      const body = {
        status: 404,
        code: "not_found",
        message: 'space "x" not found',
        issues: [
          {
            path: "space_id",
            message: "no space with this id is open on this account",
            hint: "list spaces with GET /v2/spaces",
            see_also: [{ op: "list_spaces" }],
          },
        ],
      };

      const out = respellResponse(body, index);
      expect(out.issues[0].hint).toBe("list spaces with API-list-spaces");
      expect(out.issues[0].see_also[0]).toEqual({ op: "list_spaces", tool: "API-list-spaces", args: {} });
      expect(out.message).toBe('space "x" not found');
    });

    it("rewrites a success envelope's warnings and keeps the rows", () => {
      const body = {
        data: [{ id: "1" }],
        warnings: [
          {
            message: "the fields you asked for are not all known",
            hint: "list keys with GET /v2/spaces/s/properties",
            see_also: [{ op: "list_properties", params: { space_id: "s" } }],
          },
        ],
      };

      const out = respellResponse(body, index);
      expect(out.data).toEqual([{ id: "1" }]);
      expect(out.warnings[0].hint).toBe('list keys with API-list-properties {"space_id":"s"}');
    });

    it("a malformed reference is passed through without annotation", () => {
      const refs = [{}, { op: "" }, { params: { a: "b" } }, { query: ["true"] }, { op: "list_spaces", params: ["s"] }];
      const out = respellResponse({ warnings: [{ message: "m", hint: "?0=true", see_also: refs }] }, index);
      expect(out.warnings[0].see_also).toEqual(refs);
      expect(out.warnings[0].hint).toBe("?0=true");
    });

    it("something that is not an issue is not rewritten even under an issue-shaped key", () => {
      const body = { warnings: [{ message: 5, hint: "GET /v2/spaces", see_also: [{ op: "list_spaces" }] }] };
      expect(respellResponse(body, index)).toEqual(body);
    });

    it("returns a body it cannot make sense of unchanged rather than failing the response", () => {
      const poisoned = { warnings: [{ message: "m", hint: "h", see_also: [{ op: "get_object", params: null as never }] }] };
      expect(() => respellResponse(poisoned, index)).not.toThrow();
    });

    it("passes anything else through unchanged", () => {
      expect(respellResponse("raw", index)).toBe("raw");
      expect(respellResponse(null, index)).toBeNull();
      const rows = [{ id: 1 }];
      expect(respellResponse(rows, index)).toBe(rows);
    });
  });
});
