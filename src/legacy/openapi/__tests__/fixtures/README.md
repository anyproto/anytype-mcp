# Anytype API fixtures

These fixtures derive from the local Anytype server's `/v1/docs/openapi.json` and `/v2/docs/openapi.json`, downloaded on 2026-09-15. They contain public API definitions, not account data or credentials.

They preserve paths, operation identifiers, summaries/descriptions, parameters, request bodies, and the component definitions reachable from inputs. Response descriptions and media types are preserved; response schemas are replaced with minimal placeholders because `tools/list` does not advertise output schemas. Recursive output handling has separate unit coverage.

At commit `478340d`, these fixtures produce the same serialized input tool manifests as the complete downloaded specs:

| Fixture | Tools before cleanup | Characters before cleanup |
| --- | ---: | ---: |
| v1 | 50 | 39,084 |
| v2 | 46 | 37,779 |

Measure the current implementation with `bun run measure-tools`. The script measures exactly the compact JSON structure returned by `tools/list`, without JSON-RPC envelope fields. Characters and UTF-8 bytes are reported separately; neither is a tokenizer count.

When refreshing fixtures, update the source date and deliberately review the operation list and size thresholds. Do not update them merely to make an unexpected size regression pass.
