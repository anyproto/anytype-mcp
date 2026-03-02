import axios from "axios";
import * as readline from "readline";

interface AuthToken {
  api_key: string;
}

export class AppKeyGenerator {
  private readonly rl: readline.Interface;
  private readonly appName: string = "anytype_mcp_server";
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private prompt(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.rl.question(question, resolve);
    });
  }

  private displaySuccessMessage(appKey: string, anytypeVersion: string): void {
    console.log(`\nYour APP KEY: ${appKey}`);
    console.log("\nAdd this to your MCP settings file as:");
    console.log(`
{
  "mcpServers": {
    "anytype": {
      "command": "npx",
      "args": [
        "-y",
        "@anyproto/anytype-mcp",
      ],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\\"Authorization\\":\\"Bearer ${appKey}\\", \\"Anytype-Version\\":\\"${anytypeVersion}\\"}"
      }
    }
  }
}
`);
  }

  /**
   * Start the authentication process with Anytype
   * @returns Challenge ID to use with completeAuthentication
   */
  private async startAuthentication(): Promise<string> {
    try {
      const response = await axios.post(`${this.basePath}/v1/auth/challenges`, { app_name: this.appName });

      if (!response.data?.challenge_id) {
        throw new Error("Failed to get challenge ID");
      }

      return response.data.challenge_id;
    } catch (error) {
      console.error("Authentication error:", error instanceof Error ? error.message : error);
      throw new Error("Failed to start authentication");
    }
  }

  /**
   * Complete the authentication process using the challenge ID and display code
   * @param challengeId Challenge ID from startAuthentication
   * @param code Display code shown in Anytype desktop
   * @returns Authentication tokens
   */
  private async completeAuthentication(
    challengeId: string,
    code: string,
  ): Promise<{ appKey: string; anytypeVersion: string }> {
    try {
      const response = await axios.post<AuthToken>(`${this.basePath}/v1/auth/api_keys`, {
        challenge_id: challengeId,
        code: code,
      });

      if (!response.data?.api_key) {
        throw new Error("Authentication failed: No api key received");
      }

      return { appKey: response.data.api_key, anytypeVersion: response.headers["anytype-version"] };
    } catch (error) {
      console.error("Authentication error:", error instanceof Error ? error.message : error);
      throw new Error("Failed to complete authentication");
    }
  }

  public async generateAppKey(): Promise<void> {
    try {
      console.log("Starting authentication to get app key...");

      const challengeId = await this.startAuthentication();
      console.log("Please check Anytype Desktop for the 4-digit code");
      const code = await this.prompt("Enter the 4-digit code shown in Anytype Desktop: ");

      const { appKey, anytypeVersion } = await this.completeAuthentication(challengeId, code);
      console.log("Authenticated successfully!");
      this.displaySuccessMessage(appKey, anytypeVersion);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      this.rl.close();
    }
  }
}
