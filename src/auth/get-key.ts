import * as readline from "node:readline";

/** Pairs with Anytype through the challenge flow and prints an API key with a ready configuration. */
export class ApiKeyGenerator {
  private readonly appName = "anytype_mcp_server";

  constructor(
    private readonly basePath: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown): Promise<{ data: Record<string, unknown>; headers: Headers }> {
    const response = await this.fetchImpl(new URL(path, this.basePath).href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!response.ok || typeof data !== "object" || data === null) {
      const message =
        typeof (data as { message?: unknown })?.message === "string" ? (data as { message: string }).message : "";
      throw new Error(`Anytype answered HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    return { data: data as Record<string, unknown>, headers: response.headers };
  }

  public async generateApiKey(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("Starting authentication to get API key...");
      const challenge = await this.post("/v1/auth/challenges", { app_name: this.appName });
      if (typeof challenge.data.challenge_id !== "string") throw new Error("Anytype returned no challenge id");

      console.log("Please check Anytype Desktop for the 4-digit code");
      const code = await new Promise<string>((resolve) =>
        rl.question("Enter the 4-digit code shown in Anytype Desktop: ", resolve),
      );

      const issued = await this.post("/v1/auth/api_keys", { challenge_id: challenge.data.challenge_id, code });
      if (typeof issued.data.api_key !== "string") throw new Error("Anytype returned no API key");
      console.log("Authenticated successfully!");
      this.displaySuccessMessage(issued.data.api_key, issued.headers.get("anytype-version") ?? "");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      rl.close();
    }
  }

  private displaySuccessMessage(apiKey: string, anytypeVersion: string): void {
    const headers = JSON.stringify({
      Authorization: `Bearer ${apiKey}`,
      ...(anytypeVersion ? { "Anytype-Version": anytypeVersion } : {}),
    });
    const config = {
      mcpServers: {
        anytype: { command: "npx", args: ["-y", "@anyproto/anytype-mcp"], env: { OPENAPI_MCP_HEADERS: headers } },
      },
    };
    console.log(`\nYour API KEY: ${apiKey}`);
    console.log("\nAdd this to your MCP settings file as:");
    console.log(JSON.stringify(config, null, 2));
  }
}
