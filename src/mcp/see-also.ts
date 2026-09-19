import { OpenAPIV3 } from "openapi-types";

/**
 * Typed hint references (`see_also`) — the server names the operations a
 * repair hint points at as data beside the prose, keyed by OpenAPI
 * operationId, so a caller without routes can re-spell the hint by lookup.
 *
 * The prose spells each reference exactly as the server renders it in REST
 * (method, path with bound parameters substituted, `?k=v` query with keys
 * sorted — `restSpelling` below mirrors that rule). So the re-spell is a
 * find-and-replace of that rendering with this server's own tool name and
 * arguments, never an inference from the sentence.
 *
 * Without this, an MCP caller handed `GET /v2/schemas/ops/set_properties`
 * has to work out on its own that it means `API-get-op-schema
 * {"op":"set_properties"}` — and whether it manages to correlates with model
 * strength, which is a capability gap the API manufactured.
 */

export type SeeAlsoRef = {
  /** The operation's OpenAPI operationId; absent means the request that produced the issue, resent with `query`. */
  op?: string;
  /** Path parameters by their OpenAPI name; one left out is for the caller to fill. */
  params?: Record<string, string>;
  /** Query parameters to send with the operation. */
  query?: Record<string, string>;
  /** Added here: the tool that runs the operation on this server. */
  tool?: string;
  /** Added here: the arguments to call it with. */
  args?: Record<string, unknown>;
};

export type Issue = {
  path?: string;
  message: string;
  hint?: string;
  see_also?: SeeAlsoRef[];
};

/** The declared JSON type of a path or query parameter, for typing the arguments a reference spells. */
export type ParameterType = "string" | "integer" | "number" | "boolean";

export type OperationIndex = Record<
  string,
  { method: string; path: string; tool: string; parameters: Record<string, ParameterType> }
>;

type LookupOperation = OpenAPIV3.OperationObject & { method: string; path: string };

/**
 * Follows `#/components/<kind>/<name>` references into the document's
 * components, through chains of references, with cycle protection.
 */
function resolveComponent<T extends object>(
  value: T | OpenAPIV3.ReferenceObject | undefined,
  components: OpenAPIV3.ComponentsObject | undefined,
): T | undefined {
  const seen = new Set<string>();
  let current: unknown = value;
  while (current && typeof current === "object" && "$ref" in current) {
    const ref = (current as OpenAPIV3.ReferenceObject).$ref;
    const m = /^#\/components\/([a-zA-Z]+)\/(.+)$/.exec(ref);
    if (!m || !components || seen.has(ref)) return undefined;
    seen.add(ref);
    const group = (components as Record<string, Record<string, unknown> | undefined>)[m[1]];
    current = group?.[decodeURIComponent(m[2])];
  }
  return current && typeof current === "object" ? (current as T) : undefined;
}

function parameterTypes(
  operation: LookupOperation,
  components: OpenAPIV3.ComponentsObject | undefined,
): Record<string, ParameterType> {
  const types: Record<string, ParameterType> = {};
  for (const raw of operation.parameters ?? []) {
    const param = resolveComponent<OpenAPIV3.ParameterObject>(raw, components);
    if (!param || (param.in !== "path" && param.in !== "query")) continue;
    const schema = resolveComponent<OpenAPIV3.SchemaObject>(param.schema, components);
    const type = schema?.type;
    types[param.name] = type === "integer" || type === "number" || type === "boolean" ? type : "string";
  }
  return types;
}

/**
 * Indexes the proxy's tool lookup (tool name → operation) by operationId.
 * `components` lets a `$ref` parameter or schema be typed like the tool
 * converter types it.
 */
export function buildOperationIndex(
  openApiLookup: Record<string, LookupOperation>,
  components?: OpenAPIV3.ComponentsObject,
): OperationIndex {
  const index: OperationIndex = {};
  for (const [tool, operation] of Object.entries(openApiLookup)) {
    if (operation.operationId) {
      index[operation.operationId] = {
        method: operation.method.toUpperCase(),
        path: operation.path,
        tool,
        parameters: parameterTypes(operation, components),
      };
    }
  }
  return index;
}

/**
 * Whether an operation's response with this status is a JSON envelope this
 * layer may re-spell. A file download's body is content, and content that
 * happens to be JSON with a `warnings` member is still content — it must
 * come back untouched. The declaration for the actual status is used
 * (falling back to any 2xx, then `default`), references resolved.
 */
export function servesJsonEnvelope(
  operation: OpenAPIV3.OperationObject,
  status?: number,
  components?: OpenAPIV3.ComponentsObject,
): boolean {
  const responses = operation.responses ?? {};
  // a known status: its exact declaration, then its range wildcard (`2XX`),
  // then `default` — never a different status's declaration; no status: any
  // 2xx, then `default`. No declaration, or one without content, counts as
  // JSON: the envelope is the norm and the gate exists for declared bytes.
  const declared =
    status !== undefined
      ? (responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`] ?? responses.default)
      : (Object.entries(responses).find(([code]) => /^2(\d\d|XX)$/i.test(code))?.[1] ?? responses.default);
  const response = resolveComponent<OpenAPIV3.ResponseObject>(declared, components);
  if (!response) return true;
  const content = response.content;
  if (!content || Object.keys(content).length === 0) return true;
  // application/json and any +json structured syntax (vendor subtypes may carry digits and dots)
  return Object.keys(content).some((mediaType) => /^application\/(?:[\w.+-]*\+)?json\s*(?:;|$)/i.test(mediaType.trim()));
}

function queryString(query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return "";
  return (
    "?" +
    Object.keys(query)
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join("&")
  );
}

/**
 * Renders a reference in REST exactly as the server does, so the rendering
 * can be found in the prose. An unknown op renders as the op itself, which
 * matches nothing and leaves the prose alone.
 */
export function restSpelling(ref: SeeAlsoRef, index: OperationIndex): string {
  const query = queryString(ref.query);
  if (!ref.op) return query;
  const operation = lookup(index, ref.op);
  if (!operation) return ref.op + query;
  // one pass over the template: a bound value is opaque, so a value that
  // looks like a placeholder is never re-substituted
  const path = operation.path.replace(PLACEHOLDER, (m, name: string) =>
    Object.hasOwn(ref.params ?? {}, name) ? ref.params![name] : m,
  );
  return `${operation.method} ${path}${query}`;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Own-property lookup: an op id such as `toString` must not find Object.prototype. */
function lookup(index: OperationIndex, op: string | undefined): OperationIndex[string] | undefined {
  return op !== undefined && Object.hasOwn(index, op) ? index[op] : undefined;
}

/** A well-formed reference: an op, or a resend (query only). Anything else is not a reference and is passed through. */
function isRef(value: unknown): value is SeeAlsoRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as SeeAlsoRef;
  const strings = (map: unknown) =>
    map === undefined ||
    (typeof map === "object" &&
      map !== null &&
      !Array.isArray(map) &&
      Object.values(map).every((v) => typeof v === "string"));
  if (!strings(ref.params) || !strings(ref.query)) return false;
  if (ref.op !== undefined) return typeof ref.op === "string" && ref.op !== "";
  return ref.query !== undefined && Object.keys(ref.query).length > 0;
}

/** Query values ride the wire as strings; the tool takes them in the type the OpenAPI parameter declares. */
function argValue(value: string, type: ParameterType | undefined): unknown {
  switch (type) {
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "integer":
    case "number": {
      const n = Number(value);
      return value.trim() !== "" && Number.isFinite(n) ? n : value;
    }
    default:
      return value;
  }
}

/**
 * The tool arguments a reference stands for: bound params, unbound ones as
 * `<name>` placeholders, and the query. A resend reference (no op) belongs
 * to `currentOp`, the operation that produced the issue, whose parameter
 * types apply.
 */
export function toolArgs(ref: SeeAlsoRef, index: OperationIndex, currentOp?: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const operation = lookup(index, ref.op ?? currentOp);
  if (ref.op && operation) {
    for (const match of operation.path.matchAll(PLACEHOLDER)) {
      const name = match[1];
      const bound = ref.params?.[name];
      args[name] = bound === undefined ? `<${name}>` : argValue(bound, operation.parameters[name]);
    }
  }
  for (const [name, value] of Object.entries(ref.query ?? {})) {
    args[name] = argValue(value, operation?.parameters[name]);
  }
  return args;
}

/**
 * Renders a reference in this server's vocabulary: the tool name and its
 * arguments. A resend reference (no op) is the extra arguments alone — the
 * sentence around it already says "resend with". An unknown op has no tool
 * here and renders as nothing, so the REST spelling stays in the prose
 * untouched.
 */
export function toolSpelling(ref: SeeAlsoRef, index: OperationIndex, currentOp?: string): string | undefined {
  const args = toolArgs(ref, index, currentOp);
  if (!ref.op) {
    return JSON.stringify(args);
  }
  const operation = lookup(index, ref.op);
  if (!operation) return undefined;
  return Object.keys(args).length ? `${operation.tool} ${JSON.stringify(args)}` : operation.tool;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-spells one issue: every reference's REST rendering in the hint becomes
 * its tool spelling, in ONE pass over the text (a spelling that happens to
 * contain another reference's rendering is never rewritten again), longest
 * rendering first so a reference that extends another (a read with
 * `?outline=true` extends the plain read) wins where both match; each
 * reference is annotated with `tool` and `args`. The message is a fact and
 * names no operation — the references are the hint's — so it is left alone.
 */
export function respellIssue(issue: Issue, index: OperationIndex, currentOp?: string): Issue {
  if (!Array.isArray(issue.see_also) || issue.see_also.length === 0) return issue;
  if (typeof issue.message !== "string") return issue; // not an issue at all
  // a body that merely looks like an envelope (a downloaded JSON file, say)
  // may carry anything under see_also; only well-formed references take part
  const spellings = issue.see_also
    .filter(isRef)
    .map((ref) => ({ ref, rest: restSpelling(ref, index), tool: toolSpelling(ref, index, currentOp) }))
    .sort((a, b) => b.rest.length - a.rest.length);
  const byRest = new Map<string, string>();
  for (const { rest, tool } of spellings) {
    if (rest && tool && !byRest.has(rest)) byRest.set(rest, tool);
  }
  const respell = (text: string | undefined): string | undefined => {
    if (typeof text !== "string" || !text || byRest.size === 0) return text;
    const pattern = new RegExp([...byRest.keys()].map(escapeRegExp).join("|"), "g");
    return text.replace(pattern, (m) => byRest.get(m) ?? m);
  };
  return {
    ...issue,
    ...(issue.hint !== undefined ? { hint: respell(issue.hint) } : {}),
    see_also: issue.see_also.map((ref) => {
      if (!isRef(ref)) return ref;
      const tool = toolSpelling(ref, index, currentOp);
      return {
        ...ref,
        ...(tool && ref.op ? { tool: lookup(index, ref.op)!.tool, args: toolArgs(ref, index) } : {}),
        ...(tool && !ref.op ? { args: toolArgs(ref, index, currentOp) } : {}),
      };
    }),
  };
}

/**
 * Re-spells a server response body in place of its `issues` (an error
 * envelope) and `warnings` (a success envelope). Anything else — and any
 * body the re-spell cannot make sense of — is returned as is: this is a
 * courtesy layer over a response that is already correct, and it must never
 * be the reason a response fails.
 */
export function respellResponse<T>(data: T, index: OperationIndex, currentOp?: string): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  try {
    const body = data as Record<string, unknown>;
    const out: Record<string, unknown> = { ...body };
    for (const key of ["issues", "warnings"] as const) {
      const list = body[key];
      if (Array.isArray(list)) {
        out[key] = list.map((issue) =>
          issue && typeof issue === "object" && !Array.isArray(issue)
            ? respellIssue(issue as Issue, index, currentOp)
            : issue,
        );
      }
    }
    return out as T;
  } catch {
    return data;
  }
}
