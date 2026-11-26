import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileTools } from "../local-tools";
import { FAKE_KEY, FakeHeart } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}` };
const cleanup: string[] = [];
let heart: FakeHeart | undefined;

afterEach(async () => {
  await heart?.stop();
  heart = undefined;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tools(files = {}) {
  heart = await new FakeHeart({ files }).start();
  return new LocalFileTools({ baseUrl: heart.url, headers: auth });
}

function text(result: Record<string, any>): string {
  return result.content[0].text;
}

describe("download_file", () => {
  it("saves the bytes to a private temporary file and returns where", async () => {
    const local = await tools({
      "file-1": { name: "report.pdf", type: "application/pdf", bytes: Buffer.from("%PDF") },
    });

    const result = await local.call("download_file", { space_id: "space-1", file_id: "file-1" });

    expect(result.isError).toBeUndefined();
    const saved = result.structuredContent as { path: string };
    cleanup.push(dirname(saved.path));
    expect(saved).toMatchObject({ filename: "report.pdf", media_type: "application/pdf", size: 4 });
    expect(JSON.parse(text(result))).toEqual(saved);
    expect(await readFile(saved.path, "utf8")).toBe("%PDF");
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(heart!.requests[0]).toMatchObject({ method: "GET", path: "/v2/spaces/space-1/files/file-1/content" });
    expect(heart!.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("returns Anytype's error envelope in-band", async () => {
    const local = await tools();

    const result = await local.call("download_file", { space_id: "space-1", file_id: "missing" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ code: "not_found", status: 404 });
  });

  it.each(["", ".", "..", "a/b"])("refuses %j as an id before calling Anytype", async (id) => {
    const local = await tools();

    const result = await local.call("download_file", { space_id: "space-1", file_id: id });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/file_id must be an id/);
    expect(heart!.requests).toHaveLength(0);
  });

  it("refuses arguments it does not take", async () => {
    const local = await tools();

    const result = await local.call("download_file", { space_id: "s", file_id: "f", path: "/tmp/x" });

    expect(text(result)).toMatch(/unexpected: path/);
  });
});

describe("upload_local_file", () => {
  async function localFile(name: string, content: string) {
    const dir = await mkdtemp(join(tmpdir(), "anytype-mcp-upload-test-"));
    cleanup.push(dir);
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  }

  it("uploads the file as the multipart form Anytype's REST route takes, with the caller's key", async () => {
    const local = await tools();
    const path = await localFile("notes.txt", "hello from disk");

    const result = await local.call("upload_local_file", { space_id: "space-1", path });

    expect(result).toMatchObject({ structuredContent: { object: "file", id: "uploaded-file-id" } });
    const [request] = heart!.requests;
    expect(request).toMatchObject({ method: "POST", path: "/v2/spaces/space-1/files" });
    expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(request.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const body = request.body.toString("utf8");
    expect(body).toContain('name="file"; filename="notes.txt"');
    expect(body).toContain("hello from disk");
  });

  it("passes dry_run through", async () => {
    const local = await tools();
    const path = await localFile("a.txt", "x");

    const result = await local.call("upload_local_file", { space_id: "space-1", path, dry_run: true });

    expect(result.structuredContent).toEqual({ dry_run: true });
    expect(heart!.requests[0].path).toBe("/v2/spaces/space-1/files?dry_run=true");
  });

  it("refuses a relative path, a missing file and a directory", async () => {
    const local = await tools();
    const dir = dirname(await localFile("a.txt", "x"));

    const relative = await local.call("upload_local_file", { space_id: "s", path: "a.txt" });
    const missing = await local.call("upload_local_file", { space_id: "s", path: join(dir, "nope.txt") });
    const directory = await local.call("upload_local_file", { space_id: "s", path: dir });

    expect(text(relative)).toMatch(/path must be absolute/);
    expect(text(missing)).toMatch(/no file at/);
    expect(text(directory)).toMatch(/is not a regular file/);
    expect(heart!.requests).toHaveLength(0);
  });

  it("reports an unreachable Anytype in-band", async () => {
    const local = await tools();
    const path = await localFile("a.txt", "x");
    const url = heart!.url;
    await heart!.stop();
    heart = undefined;
    const offline = new LocalFileTools({ baseUrl: url, headers: auth });

    const result = await offline.call("upload_local_file", { space_id: "s", path });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Cannot reach Anytype at .*\(ECONNREFUSED\)/);
  });
});

describe("listing", () => {
  it("offers only the names Anytype does not serve, and serves only those", () => {
    const local = new LocalFileTools({ baseUrl: "http://127.0.0.1:1" });

    const listed = local.listing(new Set(["download_file", "list_spaces"]));

    expect(listed.map((t) => t.name)).toEqual(["upload_local_file"]);
    expect(local.serves("download_file")).toBe(false);
    expect(local.serves("upload_local_file")).toBe(true);
  });
});
