import { describe, expect, it } from "vitest";
import { classify, frameError, frameResult, idKey, rawMember, sameId } from "../jsonrpc";

describe("classify, as Anytype's ClassifyMessage", () => {
  it("recognises requests, notifications and responses, keeping the raw text", () => {
    const line = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}';
    expect(classify(line)).toEqual({
      raw: line,
      kind: "request",
      method: "tools/call",
      id: "7",
      params: { name: "x" },
    });
    expect(classify('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toMatchObject({ kind: "notification" });
    expect(classify('{"jsonrpc":"2.0","id":"a","result":{}}')).toMatchObject({ kind: "response" });
  });

  it.each([
    ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600, "null", /batching/],
    ["{oops", -32700, "null", /not valid JSON/],
    ["42", -32600, "null", /is an object/],
    ['{"id":3,"method":"tools/call"}', -32600, "3", /jsonrpc must be "2.0"/],
    ['{"jsonrpc":"1.0","id":"x","method":"initialize"}', -32600, '"x"', /jsonrpc/],
    ['{"jsonrpc":"2.0","id":4,"method":"ping","params":"no"}', -32600, "4", /params/],
    ['{"jsonrpc":"2.0","id":4,"method":"ping","params":null}', -32600, "4", /params/],
    ['{"jsonrpc":"2.0","id":5,"method":7}', -32600, "5", /method must be a string/],
    ['{"jsonrpc":"2.0","id":6}', -32600, "6", /names a method/],
    ['{"jsonrpc":"2.0","id":6,"result":1,"error":{}}', -32600, "6", /not both/],
    ['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600, "null", /string or a number/],
    ['{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}', -32600, "null", /string or a number/],
    // spellings Anytype's case-insensitive Go decoder would accept as reserved members
    ['{"jsonrpc":"2.0","ID":2,"method":"tools/call"}', -32600, "null", /"ID" must be spelled "id"/],
    ['{"jsonrpc":"2.0","id":2,"Method":"tools/call"}', -32600, "null", /"Method" must be spelled "method"/],
    ['{"JSONRPC":"2.0","id":2,"method":"ping"}', -32600, "null", /must be spelled "jsonrpc"/],
    ['{"jſonrpc":"2.0","id":2,"method":"ping"}', -32600, "null", /must be spelled "jsonrpc"/],
    ['{"jsonrpc":"2.0","id":2,"Result":{}}', -32600, "null", /must be spelled "result"/],
  ])("refuses %s", (line, code, id, message) => {
    const result = classify(line);
    expect(result).toMatchObject({ kind: "invalid", code, id });
    expect((result as { message: string }).message).toMatch(message);
  });
});

describe("rawMember", () => {
  it("returns a top-level member's text exactly, however it is nested or spelled", () => {
    const text = ' { "params" : {"id": 1, "s": "}\\"{"} , "id" : 9007199254740993 , "x":[1,{"id":2}] } ';
    expect(rawMember(text, "id")).toBe("9007199254740993");
    expect(rawMember(text, "params")).toBe('{"id": 1, "s": "}\\"{"}');
    expect(rawMember(rawMember(text, "params")!, "id")).toBe("1");
    expect(rawMember(text, "missing")).toBeUndefined();
  });

  it("takes the last of duplicate members, as JSON.parse does", () => {
    expect(rawMember('{"id":1,"id":"two"}', "id")).toBe('"two"');
  });
});

describe("ids", () => {
  it("compares strings by value and numbers by their text", () => {
    expect(sameId('"\\u0061"', '"a"')).toBe(true);
    expect(sameId("9007199254740993", "9007199254740992")).toBe(false);
    expect(idKey('"a"')).not.toBe(idKey("1"));
  });

  it("frames answers under the id's own text", () => {
    expect(frameResult("9007199254740993", { ok: true })).toBe(
      '{"jsonrpc":"2.0","id":9007199254740993,"result":{"ok":true}}',
    );
    expect(JSON.parse(frameError('"x"', -32603, "boom"))).toEqual({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32603, message: "boom" },
    });
  });
});
