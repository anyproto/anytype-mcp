import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { LegacyFallback } from "./stdio-proxy";

/**
 * For an Anytype without /mcp: the tools this package used to generate from
 * the OpenAPI document, served in-process and joined to stdio through an
 * in-memory transport. Loaded only when needed, so the proxy path never
 * touches the generator. Like the old startup, a spec that cannot be loaded
 * ends the process with the reason on stderr.
 */
export const legacyFallback: LegacyFallback = async (deliver) => {
  const [{ createLegacyProxy }, { InMemoryTransport }] = await Promise.all([
    import("../legacy/init-server"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const server = await createLegacyProxy();
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  ours.onmessage = (message) => deliver(message);
  await server.connect(theirs);
  await ours.start();
  return (message) => ours.send(message as JSONRPCMessage);
};
