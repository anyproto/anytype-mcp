import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type DownloadedFile = { path: string; filename: string; media_type: string; size: number };

function downloadName(disposition: string): string {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean) || "download";
  if (encoded) {
    try {
      name = decodeURIComponent(encoded.trim());
    } catch {
      /* Fall back to filename. */
    }
  }
  // A response header must never choose a directory or overwrite an existing file.
  name = basename(name.replaceAll("\\", "/"))
    .replace(/[^a-zA-Z0-9 ._-]/g, "_")
    .slice(0, 180)
    .trim();
  return !name || name === "." || name === ".." ? "download" : name;
}

export async function saveDownload(
  data: Readable,
  headers: { get(name: string): unknown },
  signal?: globalThis.AbortSignal,
): Promise<DownloadedFile> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "anytype-mcp-download-"));
    const filename = downloadName(String(headers.get("content-disposition") || ""));
    const path = join(directory, filename);
    await pipeline(data, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
    return {
      path,
      filename,
      media_type: String(headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim(),
      size: (await stat(path)).size,
    };
  } catch (error) {
    data.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Axios returns a stream even for a download's JSON error response. Bound error buffering. */
export async function readDownloadError(data: unknown): Promise<unknown> {
  if (!(data instanceof Readable)) return data;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of data) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 64 * 1024) {
        data.destroy();
        return { code: "http_error", message: "Download failed; the error response exceeded 64 KiB." };
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return { code: "http_error", message: "Download failed; its error response could not be read." };
  }
}
