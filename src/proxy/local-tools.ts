// The two tools the proxy serves itself, beside Anytype's full tier. Both need
// the filesystem of the machine the MCP host runs on, which Anytype's MCP
// server cannot see: Anytype's upload_file fetches a URL, and download_file is
// excluded there because bytes have no text rendering. Both are confined to
// one directory (files.ts) and use the caller's own key against Anytype's REST
// routes. A tool Anytype starts serving under the same name takes precedence.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { anytypeError, redactor } from "./errors";
import { FilesRoot, multipartFile, RootError } from "./files";
import { networkCode, NEVER_CONNECTED, readBounded, withDeadline } from "./heart-client";
import { isObject, toolError, type JsonObject } from "./jsonrpc";

/** A whole transfer, body included, ends by then. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_BYTES = 64 << 10;
/** A file object's document is small: its blocks hold no content. */
const MAX_OBJECT_BYTES = 1 << 20;

/** Headers that would turn the whole-file download into part of it, or a 304. */
const PARTIAL_HEADERS = /^(range|if-range|if-none-match|if-match|if-modified-since|if-unmodified-since)$/i;

/** Extensions for the media types a download most often has; Anytype keeps a file's name without one. */
const EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "audio/mpeg": ".mp3",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
};

export interface LocalFileToolsOptions {
  baseUrl: string;
  /** OPENAPI_MCP_HEADERS: Authorization carries the caller's key. */
  headers?: Record<string, string>;
  filesDir: string;
  fetch?: typeof fetch;
}

class ArgumentError extends Error {}
class TransferError extends Error {}
/** fetch failed before any response; code is the system error, when there is one. */
class NoResponseError extends TransferError {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

export class LocalFileTools {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly root: FilesRoot;
  private readonly redact: (text: string) => string;
  private readonly definitions: JsonObject[];
  private active: Set<string>;

  constructor(options: LocalFileToolsOptions) {
    this.baseUrl = options.baseUrl;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.root = new FilesRoot(options.filesDir);
    this.redact = redactor(this.headers);
    this.definitions = definitions(options.filesDir);
    this.active = new Set(this.definitions.map((tool) => tool.name as string));
  }

  /** The local tools to list beside Anytype's, leaving out any name Anytype already serves. */
  listing(served: ReadonlySet<string>): JsonObject[] {
    const tools = this.definitions.filter((tool) => !served.has(tool.name as string));
    this.active = new Set(tools.map((tool) => tool.name as string));
    return tools.map((tool) => structuredClone(tool));
  }

  serves(name: string): boolean {
    return this.active.has(name);
  }

  /** A tools/call result; failures are in-band so the model can read them. */
  async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const deadline = withDeadline(signal, TRANSFER_TIMEOUT_MS);
    try {
      switch (name) {
        case "download_file":
          return await this.download(args, deadline.signal);
        case "upload_local_file":
          return await this.upload(args, deadline.signal);
        default:
          return toolError(`${name} is not a local tool`);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadline.timedOut())
        return toolError(`the transfer did not finish within ${TRANSFER_TIMEOUT_MS / 60_000} minutes`);
      if (error instanceof ArgumentError || error instanceof RootError || error instanceof TransferError) {
        return toolError(error.message);
      }
      // a filesystem error: its message names a path under the root, never a header
      return toolError(`the file could not be transferred (${(error as { code?: string }).code ?? "error"})`);
    } finally {
      deadline.dispose();
    }
  }

  private async download(args: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    onlyArguments("download_file", args, ["space_id", "file_id", "width"]);
    const space = segment(args, "space_id");
    const file = segment(args, "file_id");
    const width = args.width;
    if (width !== undefined && (typeof width !== "number" || !Number.isInteger(width) || width < 0)) {
      throw new ArgumentError("width must be a whole number of pixels, or 0 for the original image");
    }
    const query = width !== undefined ? `?width=${width}` : "";
    // the name is looked up first, so no unread download is held open meanwhile
    const object = await this.objectName(space, file, signal);
    const headers = Object.fromEntries(Object.entries(this.headers).filter(([name]) => !PARTIAL_HEADERS.test(name)));
    const response = await this.request(`/v2/spaces/${space}/files/${file}/content${query}`, { headers, signal });
    if (response.status !== 200) {
      if (response.ok) {
        await response.body?.cancel();
        throw new TransferError(`expected the whole file (HTTP 200), got HTTP ${response.status}; nothing was saved`);
      }
      return toolError(await restError(response, this.redact));
    }
    if (!response.body) throw new TransferError("Anytype sent no file content");
    const mediaType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    const disposition = response.headers.get("content-disposition");
    const name = fileName(
      disposition ? dispositionName(disposition) : undefined,
      object,
      mediaType,
      decodeURIComponent(file),
    );
    let saved: { path: string; size: number };
    try {
      saved = await this.root.save(name, response.body as unknown as WebReadableStream, signal);
    } catch (error) {
      // the destination could not be prepared, or the transfer broke: release the connection either way
      await response.body.cancel().catch(() => {});
      throw error;
    }
    const receipt = { path: saved.path, filename: basename(saved.path), media_type: mediaType, size: saved.size };
    return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
  }

  /** The file object's name and extension: an AnyBlock document's properties.name (a stem) and properties.file_ext. */
  private async objectName(space: string, file: string, signal: AbortSignal): Promise<{ stem?: string; ext?: string }> {
    try {
      const response = await this.request(`/v2/spaces/${space}/objects/${file}`, { headers: this.headers, signal });
      const object = response.ok ? parseObject((await readBounded(response, MAX_OBJECT_BYTES)) ?? "") : undefined;
      await response.body?.cancel().catch(() => {});
      const properties = isObject(object?.properties) ? object.properties : {};
      return {
        stem: typeof properties.name === "string" && properties.name.trim() ? properties.name : undefined,
        ext:
          typeof properties.file_ext === "string" && /^[A-Za-z0-9]{1,16}$/.test(properties.file_ext)
            ? `.${properties.file_ext}`
            : undefined,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      // a name is a convenience; the id will do
      return {};
    }
  }

  private async upload(args: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    onlyArguments("upload_local_file", args, ["space_id", "path", "dry_run"]);
    const space = segment(args, "space_id");
    if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") {
      throw new ArgumentError("dry_run must be true or false");
    }
    const { handle, name } = await this.root.openForUpload(args.path);
    try {
      const form = multipartFile(handle, name);
      const query = args.dry_run === true ? "?dry_run=true" : "";
      let response: Response;
      try {
        response = await this.request(`/v2/spaces/${space}/files${query}`, {
          method: "POST",
          // a fresh key per call: the proxy does not retry, so it only marks the write
          headers: { ...this.headers, "Content-Type": form.contentType, "Idempotency-Key": randomUUID() },
          body: form.body,
          duplex: "half",
          signal,
        });
      } catch (error) {
        // a connection that never opened sent nothing; one lost after that may have stored the file
        if (error instanceof NoResponseError && !NEVER_CONNECTED.has(error.code ?? "")) {
          return toolError(
            "the upload outcome is unconfirmed: the connection to Anytype closed before it answered. " +
              "Check the space for the file before uploading it again.",
          );
        }
        throw error;
      }
      if (!response.ok) return toolError(await restError(response, this.redact));
      // a receipt that breaks off is no receipt: the upload may have been stored, so it is
      // reported unconfirmed (check before retrying) rather than as a failed transfer
      const text = (await readBounded(response, 1 << 20).catch(() => undefined)) ?? "";
      const receipt = parseObject(text);
      // Anytype's receipt: 201 with the stored file's id, or 200 { dry_run: true } for a dry run.
      // Anything else (a login page from a proxy, a cut-off body) is not proof the upload happened.
      const confirmed =
        args.dry_run === true
          ? response.status === 200 && receipt?.dry_run === true
          : response.status === 201 && typeof receipt?.id === "string" && receipt.id !== "";
      if (!confirmed) {
        return toolError(
          `the upload outcome is unconfirmed: Anytype answered HTTP ${response.status} without its upload receipt. ` +
            "Check the space for the file before uploading it again.",
        );
      }
      return { content: [{ type: "text", text }], structuredContent: receipt };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** fetch without following redirects, a failure to connect told apart from the rest. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl).href, { ...init, redirect: "manual" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const code = networkCode(error);
      throw new NoResponseError(
        `Cannot reach Anytype at ${this.baseUrl}${code ? ` (${code})` : ""}. Ask the user to start the Anytype app; ` +
          "changing the call will not help.",
        code,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TransferError(`Anytype answered HTTP ${response.status} with a redirect, which is not followed`);
    }
    return response;
  }
}

function definitions(filesDir: string): JsonObject[] {
  return [
    {
      name: "download_file",
      description:
        `Download a file's bytes into ${filesDir} on the computer running this MCP server and return its local ` +
        "path, filename, media_type and size. The file gets a new name there; nothing is overwritten. file_id is " +
        "the file object's id, as upload_file and upload_local_file return it and file and image blocks reference it.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string", description: "Space id, from `list_spaces`" },
          file_id: { type: "string", description: "File object id, or an icon_image value" },
          width: {
            type: "integer",
            minimum: 0,
            description: "Image variant width in pixels; 0 or absent for the original",
          },
        },
        required: ["space_id", "file_id"],
        additionalProperties: false,
      },
    },
    {
      name: "upload_local_file",
      description:
        `Upload a file from ${filesDir} on the computer running this MCP server into a space. Only files in that ` +
        "directory can be uploaded: ask the user to put the file there first. Returns the stored file object's id, " +
        "which file blocks, image blocks and icon_image values reference. For a file on the web, use upload_file with its url.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string", description: "Space id, from `list_spaces`" },
          path: { type: "string", description: `The file's path relative to ${filesDir}, e.g. report.pdf` },
          dry_run: { type: "boolean", description: "Validate and report without committing" },
        },
        required: ["space_id", "path"],
        additionalProperties: false,
      },
    },
  ];
}

function onlyArguments(tool: string, args: JsonObject, allowed: string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ArgumentError(`${tool} takes ${allowed.join(", ")}; unexpected: ${unexpected.join(", ")}`);
  }
}

/** A path argument is one URL segment: an id, never a way onto another route. */
function segment(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new ArgumentError(`${key} must be an id (one path segment); got ${JSON.stringify(value ?? null)}`);
  }
  return encodeURIComponent(value);
}

function dispositionName(disposition: string): string | undefined {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // fall through to the plain parameter
    }
  }
  return /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean)?.trim() || undefined;
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A download's file name. A Content-Disposition filename is complete as sent.
 * Otherwise Anytype's object name is a stem (`report.v2`, `archive.tar`) and
 * its file_ext the extension, so the two are joined; without file_ext the
 * media type's usual extension is added unless the stem already ends in it.
 */
export function fileName(
  disposition: string | undefined,
  object: { stem?: string; ext?: string },
  mediaType: string,
  fileId: string,
): string {
  if (disposition) return disposition;
  const stem = object.stem ?? fileId;
  if (object.ext) return `${stem}${object.ext}`;
  const usual = EXTENSIONS[mediaType];
  return usual && !stem.toLowerCase().endsWith(usual) ? `${stem}${usual}` : stem;
}

/**
 * Anytype's error (status, code, message, issues) and nothing else: another
 * server's body is reported by its status only, and the configured
 * credentials are redacted from whatever is quoted.
 */
async function restError(response: Response, redact: (text: string) => string): Promise<string> {
  // the body is a diagnostic: if it breaks off, the status alone is reported
  const body = parseObject((await readBounded(response, MAX_ERROR_BYTES).catch(() => undefined)) ?? "");
  const error = anytypeError(body, response.status, redact);
  if (error) return JSON.stringify({ status: response.status, ...error });
  return `Anytype answered HTTP ${response.status}`;
}
