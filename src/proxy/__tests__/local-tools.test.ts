import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileTools } from "../local-tools";
import { FAKE_KEY, FakeHeart, type FakeHeartOptions } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}` };
let heart: FakeHeart | undefined;
let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "anytype-mcp-files-test-"));
  root = join(base, "files"); // created by the tools on first use
});

afterEach(async () => {
  await heart?.stop();
  heart = undefined;
  await rm(base, { recursive: true, force: true });
});

async function tools(options: FakeHeartOptions = {}, headers: Record<string, string> = auth) {
  heart = await new FakeHeart(options).start();
  return new LocalFileTools({ baseUrl: heart.url, headers, filesDir: root });
}

function text(result: Record<string, any>): string {
  return result.content[0].text;
}

const pdf = { "file-1": { name: "report.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.7 hello") } };

describe("download_file", () => {
  it("saves the whole file into the root, owner-only, named after the object", async () => {
    const local = await tools({ files: pdf });

    const result = await local.call("download_file", { space_id: "space-1", file_id: "file-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      path: join(root, "report.pdf"),
      filename: "report.pdf",
      media_type: "application/pdf",
      size: 14,
    });
    expect(await readFile(join(root, "report.pdf"), "utf8")).toBe("%PDF-1.7 hello");
    expect((await stat(join(root, "report.pdf"))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(heart!.requests[0]).toMatchObject({ method: "GET", path: "/v2/spaces/space-1/files/file-1/content" });
    expect(heart!.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("takes the extension from the file object's file_ext before the media type", async () => {
    const local = await tools({
      files: { "file-2": { name: "notes.markdown", type: "text/plain", bytes: Buffer.from("# hi") } },
    });

    const result = await local.call("download_file", { space_id: "s", file_id: "file-2" });

    expect((result.structuredContent as { filename: string }).filename).toBe("notes.markdown");
  });

  it("never overwrites: a second download gets a new name", async () => {
    const local = await tools({ files: pdf });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "report.pdf"), "mine");

    const first = await local.call("download_file", { space_id: "s", file_id: "file-1" });
    const second = await local.call("download_file", { space_id: "s", file_id: "file-1" });

    expect((first.structuredContent as { filename: string }).filename).toBe("report (2).pdf");
    expect((second.structuredContent as { filename: string }).filename).toBe("report (3).pdf");
    expect(await readFile(join(root, "report.pdf"), "utf8")).toBe("mine");
  });

  it("asks for the whole file and saves nothing that is not HTTP 200", async () => {
    const local = await tools(
      {
        files: pdf,
        intercept: (request, res) => {
          if (!request.path.endsWith("/content")) return false;
          res.writeHead(206, { "Content-Type": "application/pdf", "Content-Range": "bytes 0-1/14" }).end("%P");
          return true;
        },
      },
      { ...auth, Range: "bytes=0-1", "If-None-Match": '"x"' },
    );

    const result = await local.call("download_file", { space_id: "s", file_id: "file-1" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/expected the whole file \(HTTP 200\), got HTTP 206; nothing was saved/);
    expect(heart!.requests[0].headers.range).toBeUndefined();
    expect(heart!.requests[0].headers["if-none-match"]).toBeUndefined();
    await expect(stat(join(root, "report.pdf"))).rejects.toThrow();
  });

  it("forwards an image width", async () => {
    const local = await tools({ files: pdf });

    await local.call("download_file", { space_id: "s", file_id: "file-1", width: 320 });

    expect(heart!.requests[0].path).toBe("/v2/spaces/s/files/file-1/content?width=320");
    expect(text(await local.call("download_file", { space_id: "s", file_id: "file-1", width: -1 }))).toMatch(
      /width must be/,
    );
  });

  it("does not follow a redirect", async () => {
    const local = await tools({
      intercept: (_request, res) => {
        res.writeHead(302, { Location: "http://example.invalid/elsewhere" }).end();
        return true;
      },
    });

    const result = await local.call("download_file", { space_id: "s", file_id: "f" });

    expect(text(result)).toMatch(/HTTP 302 with a redirect, which is not followed/);
    expect(heart!.requests).toHaveLength(1);
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

    expect(text(result)).toMatch(/file_id must be an id/);
    expect(heart!.requests).toHaveLength(0);
  });
});

describe("upload_local_file", () => {
  async function inRoot(name: string, content: string | Buffer) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }

  it("uploads a file from the root as the multipart form Anytype's REST route takes", async () => {
    const local = await tools();
    await inRoot("notes/today.txt", "hello from disk");

    const result = await local.call("upload_local_file", { space_id: "space-1", path: "notes/today.txt" });

    expect(result).toMatchObject({ structuredContent: { object: "file", id: "uploaded-file-id" } });
    const [request] = heart!.requests;
    expect(request).toMatchObject({ method: "POST", path: "/v2/spaces/space-1/files" });
    expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(request.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const body = request.body.toString("utf8");
    expect(body).toContain('name="file"; filename="today.txt"');
    expect(body).toContain("\r\n\r\nhello from disk\r\n--");
  });

  it("streams a large file intact", async () => {
    const local = await tools();
    const bytes = randomBytes(5 * 1024 * 1024 + 17);
    await inRoot("big.bin", bytes);

    await local.call("upload_local_file", { space_id: "s", path: "big.bin" });

    expect(heart!.requests[0].body.includes(bytes)).toBe(true);
  });

  it("passes dry_run through", async () => {
    const local = await tools();
    await inRoot("a.txt", "x");

    const result = await local.call("upload_local_file", { space_id: "space-1", path: "a.txt", dry_run: true });

    expect(result.structuredContent).toEqual({ dry_run: true });
    expect(heart!.requests[0].path).toBe("/v2/spaces/space-1/files?dry_run=true");
  });

  it.each([
    ["an absolute path", "/etc/passwd", /must be relative to/],
    ["a home path", "~/secret.txt", /must be relative to/],
    ["a UNC path", "\\\\server\\share\\x.txt", /must be relative to/],
    ["a forward-slash UNC path", "//server/share/x.txt", /must be relative to/],
    ["a drive path", "C:\\Users\\x.txt", /must be relative to/],
    ["a path climbing out", "../outside.txt", /is outside/],
    ["a missing file", "nope.txt", /there is no file nope\.txt in/],
    ["a directory", "sub", /is not a regular file/],
  ])("refuses %s, naming the root", async (_, path, message) => {
    const local = await tools();
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(base, "outside.txt"), "not yours");

    const result = await local.call("upload_local_file", { space_id: "s", path });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(text(result)).toContain(root);
    expect(heart!.requests).toHaveLength(0);
  });

  it("refuses a symbolic link that leads out of the root", async () => {
    const local = await tools();
    await mkdir(root, { recursive: true });
    await writeFile(join(base, "outside.txt"), "not yours");
    await symlink(join(base, "outside.txt"), join(root, "link.txt"));

    const result = await local.call("upload_local_file", { space_id: "s", path: "link.txt" });

    expect(text(result)).toMatch(/links outside/);
    expect(heart!.requests).toHaveLength(0);
  });

  it("reports an unreachable Anytype in-band", async () => {
    const local = await tools();
    await inRoot("a.txt", "x");
    await heart!.stop();
    heart = undefined;

    const result = await local.call("upload_local_file", { space_id: "s", path: "a.txt" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Cannot reach Anytype at .*\(ECONNREFUSED\)/);
  });
});

describe("listing", () => {
  it("offers only the names Anytype does not serve, names the root, and serves only those", () => {
    const local = new LocalFileTools({ baseUrl: "http://127.0.0.1:1", filesDir: "/data/ai-files" });

    const listed = local.listing(new Set(["download_file", "list_spaces"]));

    expect(listed.map((t) => t.name)).toEqual(["upload_local_file"]);
    expect(listed[0].description).toContain("/data/ai-files");
    expect(local.serves("download_file")).toBe(false);
    expect(local.serves("upload_local_file")).toBe(true);
  });
});
