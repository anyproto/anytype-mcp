# MCP tool cleanup plan

Status: implemented and verified locally.

Implementation decisions:

- File downloads are retained with a streaming-to-disk adapter that returns a local path and metadata. Chat event streams remain excluded until a bounded adapter is implemented.
- Optional `request_key` and `expected_etag` inputs replace the advertised HTTP header names; legacy spellings remain accepted.
- Automatic discovery prefers `/v2/docs/openapi.json`, falling back to the legacy `/docs/openapi.json` on HTTP 404 or 410. Explicit spec URLs/files stay pinned. The selected document supplies the actual API routes.
- Known v1 object writes return compact identity receipts instead of echoing object content. v2 create/edit receipts, warnings, generated IDs, reads, searches, and error details are preserved.

Validation: automated coverage includes API discovery and fallback, explicit spec selection, wrapped and flat bodies, retry-key headers, etag metadata, stale-etag errors without retries, and binary downloads. Receipt regression tests cover large v1 objects, metadata, v2 results, reads, searches, and errors. Built-CLI checks use temporary HTTP fixture servers; no authenticated writes to a real Anytype space were performed.

| Manifest | Before | After | Tools after |
| --- | ---: | ---: | ---: |
| v1 | 39,084 characters | 32,945 characters | 49 |
| v2 | 37,779 characters | 19,681 characters | 46 |

The body fix is recorded separately in local commit `478340d`. The cleanup is a local build, not an npm release.

## Objective

Reduce the tool definitions sent to an LLM while preserving useful API capabilities and correct request behavior. Keep the existing body-serialization fix as a separate change.

## Measured baseline

Measured on 2026-09-15 from the v2 specification downloaded from the server on port 31009, using this repository's converter and the shape returned by `tools/list`.

| Item | Current result |
| --- | ---: |
| Exposed v2 tools | 46 |
| Serialized `tools/list` JSON | 37,779 characters |
| After removing appended HTTP-error catalogs only | 20,399 characters |
| Reduction from error catalogs | 17,380 characters / approximately 46% |
| Header input definitions | 14 occurrences / approximately 1,500 characters |

These are character counts, not token counts. Token measurements should name the tokenizer used. Re-measure against fixed v1 and v2 fixtures so API updates do not distort comparisons.

## 0. Keep the request-body fix separate

- Land the existing fix for wrapped JSON bodies and parameter routing independently of this cleanup.
- Preserve its regression coverage for flat inputs, wrapped documents, arrays/scalars, references, headers, and multipart fields.
- Authenticated end-to-end writes remain unverified; the current checks inspect serialized requests without sending them.

## 1. Remove redundant description text

Primary file: `src/openapi/parser.ts`.

- Stop appending every 4xx/5xx response description to each MCP tool description.
- Keep a concise description of what the operation does and any essential usage constraints, especially accepted body forms.
- Keep input descriptions that explain formats, allowed values, pagination, and consequential options.
- Omit empty schema metadata, such as `$defs: {}`, where unnecessary. Preserve definitions that references actually use.
- Continue returning the server's actual error code, message, issues, and hints when a call fails.

Acceptance:

- The fixed v2 fixture's serialized tool list is at most approximately 20,400 characters before adding any new descriptions.
- Tool names, input fields, and outgoing requests are unaffected by description removal.
- Tests assert essential descriptions and error propagation without requiring the old error catalogs.

## 2. Centralize parameter policy

Primary files: a small policy module under `src/openapi/`, the parser, and `src/client/http-client.ts`.

Replace scattered exclusions with one policy that records whether a parameter is exposed, supplied by configuration, managed by the wrapper, or omitted. Key rules by parameter location and name, with operation-specific overrides when needed.

The same policy must drive both the advertised schema and request routing. An input alias must map to its original header; a hidden parameter must not reappear in JSON or multipart bodies. Do not hide an unfamiliar required parameter without supplying a valid value or reporting the configuration problem.

Proposed treatment:

| Parameter | Treatment | Implementation |
| --- | --- | --- |
| Authorization, `Anytype-Version` | Configuration-owned | Keep out of model inputs; inject configured values. |
| `Range`, `If-None-Match`, `If-Range` | Omit from normal tools | Let a future download adapter own partial transfers and caching. |
| `Last-Event-ID`, `heartbeat` | Omit with the streaming tool | Add only with a bounded streaming adapter. |
| `Idempotency-Key` | Move to wrapper ownership in step 3 | Keep the existing input until retry semantics are implemented and tested. |
| `If-Match` | Retain concurrency protection | Expose a concise optional `expected_etag` input and map it to the header. Provide the returned etag when it is available. |
| `dry_run`, `create_missing_options` | Keep | These change whether and how data is written. |
| Pagination, `fields`, `include`, `outline`, `block`, `format`, `view`, `ids` | Keep initially | They control retrieval cost, returned content, or ID representation. Shorten descriptions where possible. |

Keep schema-discovery tools: the LLM needs them to construct the open-ended v2 request documents.

Compatibility:

- Preserve existing operation-based tool names.
- Accept the old `If-Match` spelling during a documented transition without advertising both spellings to the model; reject conflicting values if both are supplied.
- Use one shared parameter policy for the exported MCP, OpenAI, and Anthropic converters. Test their intended input mappings; avoid three separate exclusion lists.
- Inventory the existing `filters` exclusions separately. Restoring search-filter support is a functional change, not a token reduction.

## 3. Define wrapper-managed idempotency precisely

- Generate a unique key for each new logical write on an endpoint that declares support for `Idempotency-Key`.
- Reuse that key for any transport retry of that same invocation. Never use one global configured key or a body hash shared by separate writes.
- Distinguish a transport retry from a new MCP call. A new call may intentionally repeat the same write; do not silently deduplicate it.
- If callers need to retry across separate MCP calls, retain a concise optional `request_key` input with documented reuse semantics. An automatically generated per-call key alone cannot solve that case.
- Do not add automatic write retries as part of token cleanup. Any later retry policy must reuse the key and handle ambiguous outcomes explicitly.

Acceptance: simulated retries reuse a key, independent identical writes use different keys, explicit cross-call reuse works as documented, and keys never enter the document body.

## 4. Expose only response types the proxy can handle

Primary files: `src/openapi/parser.ts` and `src/mcp/proxy.ts`.

- Exclude chat event-stream operations until the proxy can return a bounded result. Ordinary message listing remains available.
- Retain file downloads through a dedicated adapter that streams to a private temporary file and returns path, media type, and size. Remove interrupted downloads. Keep supported file uploads; exclude other unsupported response types.
- Use explicit capability rules and overrides rather than blindly including every HTTP operation. Distinguish an unsupported response mode from an ordinary optional parameter.
- Replace the blanket `Auth` exclusion with explicit pairing/credential-operation exclusions. Review `auth_whoami` as useful identity/scope discovery; add it only if its output is suitable for model use.
- Reject duplicate final tool names at startup, after normalization and truncation. This prevents silently choosing a route if overlapping v1/v2 operations are ever supplied together.

Acceptance: normal tools return finite, usable results; unsupported operations are omitted consistently from listing and dispatch; identity discovery does not expose credentials; duplicate names produce an actionable error.

## 5. Improve actual errors and remove debug noise

Primary files: `src/mcp/proxy.ts` and `src/client/http-client.ts`.

- Mark failed calls with MCP `isError: true` and retain the HTTP status plus the API's code, message, issues, and hints.
- Compact the known v1 object-write responses into identity receipts. Preserve their metadata and pass through v2 receipts, reads, searches, and errors.
- Remove routine dumps of the entire operation lookup, arguments, bodies, and complete error objects. Offer concise debug logging when requested.
- Remove the dead commented Zod-generation code and its redundant fallback block while editing the parser. Treat this as maintenance; it is not part of the measured tool-token savings.

Richer validation wording inside the Anytype API is a separate server-side change. The wrapper should faithfully preserve the information the server already returns.

## Delivery order and validation

1. Existing body fix.
2. Description cleanup and size measurement; runtime error reporting and debug-log cleanup can accompany it.
3. Shared parameter policy, concurrency alias, and capability exclusions.
4. Idempotency ownership once the behavior above is implemented and tested.

For each relevant change:

- Compare generated tool manifests from fixed v1 and v2 fixtures.
- Assert the presence of useful controls and absence of hidden inputs.
- Inspect actual serialized URL, query, headers, JSON, and multipart requests using an intercepted Axios adapter.
- Cover stale-etag failures and idempotency behavior before claiming those protections work end to end.
- Run the existing tests, type/build checks, lint, formatting, and a built-CLI MCP listing check.
- For authenticated integration validation, prefer dry runs; perform any required persistent-write checks in an explicitly designated test space.
- Document the visible input changes and local configuration before preparing a release.

Probe `/v2/docs/openapi.json` at startup and fall back to `/docs/openapi.json` only when the versioned endpoint is absent (404 or 410). Keep explicit spec URLs pinned. Reuse the chosen specification for the process lifetime without fetching it on each tool call; restart to discover API upgrades. A merged version surface should be designed separately.
