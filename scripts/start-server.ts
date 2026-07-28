import { ApiKeyGenerator } from "../src/auth/get-key";
import { initProxy, loadOpenApiSpec, ValidationError } from "../src/init-server";
import { determineBaseUrl, overrideSpecPath } from "../src/utils/base-url";

async function generateApiKey() {
  const openApiSpec = await loadOpenApiSpec();
  const baseUrl = determineBaseUrl(openApiSpec);
  const generator = new ApiKeyGenerator(baseUrl);
  await generator.generateApiKey();
}

export async function main(args: string[] = process.argv.slice(2)) {
  const [command, specPath] = args;
  overrideSpecPath(specPath);
  if (!command || command === "run") {
    await initProxy();
  } else if (command === "get-key") {
    await generateApiKey();
  } else {
    console.error(`Error: Unknown command "${command}"`);
    process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof ValidationError) {
    console.error("Invalid OpenAPI 3.1 specification:");
    error.errors.forEach((err) => console.error(err));
  } else {
    console.error("Error:", error.message);
  }
  process.exit(1);
});
