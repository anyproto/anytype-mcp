// The bin entry (bundled to bin/cli.mjs). The commands live in src/cli.ts, which
// has no side effects on import.
import { main } from "../src/cli";
import { ValidationError } from "../src/legacy/init-server";

main().catch((error) => {
  if (error instanceof ValidationError) {
    console.error("Invalid OpenAPI 3.1 specification:");
    error.errors.forEach((err) => console.error(err));
  } else {
    console.error("Error:", error.message);
  }
  process.exit(1);
});
