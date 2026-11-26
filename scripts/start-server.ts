// The bin entry (bundled to bin/cli.mjs). The commands live in src/cli.ts, which
// has no side effects on import, and serves configuration errors itself; what
// reaches here is get-key's or an unexpected failure.
import { main } from "../src/cli";

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
