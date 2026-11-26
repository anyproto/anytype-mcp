// A files directory without hard links (FAT, exFAT): the download must fail
// rather than appear partially under its name. link() is replaced to fail the
// way it does there; everything else is the real filesystem.
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalFileTools } from "../local-tools";
import { FAKE_KEY, FakeHeart } from "./fake-heart";

let linkError: string | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    link: async (existing: string, created: string) => {
      if (linkError) throw Object.assign(new Error(`${linkError}: link`), { code: linkError });
      return actual.link(existing, created);
    },
  };
});

let heart: FakeHeart | undefined;
let dir = "";
afterEach(async () => {
  linkError = undefined;
  await heart?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(["EPERM", "ENOTSUP", "EXDEV"])("fails with %s from link, leaving nothing in the directory", async (code) => {
  heart = await new FakeHeart({
    files: { f: { name: "a.txt", type: "text/plain", bytes: Buffer.from("hello") } },
  }).start();
  dir = await mkdtemp(join(tmpdir(), "anytype-mcp-nolink-"));
  linkError = code;
  const tools = new LocalFileTools({
    baseUrl: heart.url,
    headers: { Authorization: `Bearer ${FAKE_KEY}` },
    filesDir: dir,
  });

  const result = await tools.call("download_file", { space_id: "s", file_id: "f" });

  expect(result.isError).toBe(true);
  expect((result.content as Array<{ text: string }>)[0].text).toMatch(
    new RegExp(`could not be saved in .*hard link, which failed \\(${code}\\).*not FAT or exFAT.*nothing was saved`),
  );
  expect(await readdir(dir)).toEqual([]);
});
