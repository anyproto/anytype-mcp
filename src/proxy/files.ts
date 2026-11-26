// The one directory the local file tools may touch (default ~/.anytype-mcp/files,
// ANYTYPE_MCP_FILES_DIR to move it). The model chooses paths, so every path is
// checked against the root before the filesystem is asked anything about it,
// and again after symbolic links are resolved.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** A refusal whose message names the root, so the model can tell the user where files go. */
export class RootError extends Error {}

export class FilesRoot {
  constructor(readonly dir: string) {}

  /** Creates the root on first use (owner-only) and returns its real path. */
  async real(): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return realpath(this.dir);
  }

  /**
   * Opens a regular file under the root for reading. path is relative to the
   * root; anything that could leave it — an absolute, drive or UNC path, `..`,
   * a symbolic link pointing out — is refused.
   */
  async openForUpload(path: unknown): Promise<{ handle: FileHandle; name: string; size: number }> {
    if (typeof path !== "string" || path.trim() === "") {
      throw new RootError(`path must name a file in ${this.dir}, relative to it`);
    }
    // decided on the text alone, so no network path is ever looked up
    if (
      path.includes("\0") ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      /^[a-zA-Z]:/.test(path) ||
      path.startsWith("~") ||
      /^[\\/]{2}/.test(path)
    ) {
      throw new RootError(
        `path must be relative to ${this.dir}; got an absolute path. Ask the user to copy the file into ${this.dir}.`,
      );
    }
    const root = await this.real();
    const candidate = resolve(root, path);
    if (!inside(root, candidate)) {
      throw new RootError(`${path} is outside ${this.dir}. Ask the user to copy the file into ${this.dir}.`);
    }
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new RootError(`there is no file ${path} in ${this.dir}`);
    }
    if (!inside(root, real)) {
      throw new RootError(`${path} links outside ${this.dir}. Ask the user to copy the file itself into ${this.dir}.`);
    }
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer,
    // beyond the reach of cancellation; the descriptor is checked below
    const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new RootError(`${path} in ${this.dir} is not a regular file`);
    }
    return { handle, name: basename(real), size: info.size };
  }

  /**
   * Saves a download under the root as a new file named after `name`. The
   * bytes go to a private temporary entry first; only a complete file is
   * published, under a name nothing else holds (an existing file is never
   * replaced), and a failure removes the temporary entry and nothing else.
   * The destination is prepared before the body is read, so a caller whose
   * save fails early still owns the unread body.
   */
  async save(name: string, body: WebReadableStream, signal?: AbortSignal): Promise<{ path: string; size: number }> {
    const root = await this.real();
    const temp = join(root, `.anytype-mcp-${randomUUID()}.part`);
    const handle = await open(temp, "wx", 0o600);
    let size = 0;
    try {
      const counted = Readable.fromWeb(body);
      counted.on("data", (chunk: Buffer) => (size += chunk.length));
      await pipeline(counted, handle.createWriteStream(), { signal });
      const path = await publish(temp, root, safeName(name), this.dir);
      // reported under the root as configured, the name the user knows it by
      return { path: join(this.dir, basename(path)), size };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    } finally {
      // ours by its random name; a published file keeps its own link
      await unlink(temp).catch(() => {});
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Gives the finished temporary file its name with a hard link: atomic, and it
 * fails rather than replace an existing entry, so a file appears under its
 * name only complete and never over another. Numbered on collision. Without
 * hard links (FAT, exFAT) there is no such operation, and the download fails
 * rather than appear partially under its name.
 */
async function publish(temp: string, root: string, name: string, shown: string): Promise<string> {
  const ext = extensionOf(name);
  const stem = name.slice(0, name.length - ext.length) || "download";
  const candidates = [`${stem}${ext}`];
  for (let n = 2; n <= 100; n++) candidates.push(`${stem} (${n})${ext}`);
  candidates.push(`${stem}-${randomUUID().slice(0, 8)}${ext}`);
  for (const candidate of candidates) {
    const path = join(root, candidate);
    try {
      await link(temp, path);
      return path;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw new RootError(
        `the download could not be saved in ${shown}: publishing it needs a hard link, which failed ` +
          `(${errorCode(error) ?? "error"}). Ask the user to set ANYTYPE_MCP_FILES_DIR to a directory on a ` +
          "filesystem with hard links (not FAT or exFAT); nothing was saved.",
      );
    }
  }
  throw new RootError(`no free file name for the download in ${shown}`);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/** A name's extension when it looks like one (`.pdf`, `.gz`), else empty. */
export function extensionOf(name: string): string {
  const ext = extname(name);
  return /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? ext : "";
}

/** Filesystems allow 255 bytes per name (ext4, APFS) or 255 UTF-16 units (NTFS), which bytes bound too. */
const MAX_NAME_BYTES = 255;
/** Room for the collision suffix: " (100)" is 6 bytes, "-xxxxxxxx" 9. */
const SUFFIX_BYTES = 10;
/** And a short name keeps the whole path within Windows' default limit. */
const MAX_NAME_CHARS = 120;

/**
 * A file name safe on every platform: no separators, no device names, nothing
 * hidden. The stem is shortened by code points so that it, the extension and
 * a collision suffix stay within 255 UTF-8 bytes and 120 characters.
 */
export function safeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const ext = extensionOf(cleaned);
  let stem = shorten(
    cleaned.slice(0, cleaned.length - ext.length),
    MAX_NAME_BYTES - SUFFIX_BYTES - Buffer.byteLength(ext),
    MAX_NAME_CHARS - ext.length,
  ).replace(/[\s.]+$/g, "");
  if (!stem || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem.split(".")[0])) stem = "download";
  return `${stem}${ext}`;
}

/** The longest prefix within both limits, never splitting a code point. */
function shorten(text: string, maxBytes: number, maxChars: number): string {
  let out = "";
  let bytes = 0;
  let chars = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes || chars + point.length > maxChars) break;
    out += point;
    bytes += size;
    chars += point.length;
  }
  return out;
}

/**
 * A multipart/form-data body with one `file` part, streamed from the open
 * file: nothing is read into memory beyond the stream's own buffer.
 */
export function multipartFile(handle: FileHandle, filename: string) {
  const boundary = `anytype-mcp-${randomUUID()}`;
  // the HTML form encoding of a file name: quote and line breaks percent-encoded
  const quoted = filename.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* parts() {
    yield head;
    for await (const chunk of handle.createReadStream({ autoClose: false })) yield chunk as Buffer;
    yield tail;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: parts() };
}
