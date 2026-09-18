import type { InternalAxiosRequestConfig } from "axios";
import { Buffer } from "node:buffer";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAPIToMCPConverter } from "../../openapi/parser";
import { readDownloadError, saveDownload, type DownloadedFile } from "../download-file";
import { HttpClient } from "../http-client";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("file download adapter", () => {
  const spec: OpenAPIV3.Document = {
    openapi: "3.0.0",
    info: { title: "Downloads", version: "2" },
    servers: [{ url: "http://localhost:31009" }],
    paths: {
      "/v2/spaces/{space_id}/files/{file_id}/content": {
        get: {
          operationId: "download_file",
          summary: "Download a file",
          parameters: [
            { name: "space_id", in: "path", required: true, schema: { type: "string" } },
            { name: "file_id", in: "path", required: true, schema: { type: "string" } },
            { name: "Range", in: "header", schema: { type: "string" } },
          ],
          responses: { "200": { description: "File bytes", content: { "application/octet-stream": {} } } },
        },
      },
    },
  };

  it("keeps the download tool, saves exact bytes, and returns a usable local path", async () => {
    const { zip } = new OpenAPIToMCPConverter(spec).convertToMCPTools();
    const { openApi: operation, mcp: tool } = zip["API-download-file"];
    expect(tool.description).toContain("Saves locally");
    expect(tool.inputSchema.properties).not.toHaveProperty("Range");
    const bytes = Buffer.from([0, 255, 128, 65, 10]);
    const client = new HttpClient({ baseUrl: "http://localhost:31009" }, spec);
    const api = await client["api"];
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      data: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      status: 200,
      statusText: "OK",
      config,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="../../sample.bin"',
        etag: '"revision"',
      },
    }));
    api.defaults.adapter = adapter;

    const response = await client.executeOperation<DownloadedFile>(operation, {
      space_id: "space-1",
      file_id: "file-1",
      Range: "bytes=0-1",
    });
    directories.push(dirname(response.data.path));

    expect(await readFile(response.data.path)).toEqual(bytes);
    expect(response.data).toEqual({
      path: expect.stringContaining("anytype-mcp-download-"),
      filename: "sample.bin",
      media_type: "application/octet-stream",
      size: 5,
    });
    expect((await stat(response.data.path)).mode & 0o777).toBe(0o600);
    const config = adapter.mock.calls[0][0];
    expect(config.responseType).toBe("stream");
    expect(config.headers.has("Range")).toBe(false);
    expect(new URL(api.getUri(config)).pathname).toBe("/v2/spaces/space-1/files/file-1/content");
    expect(response.headers.get("etag")).toBe('"revision"');
  });

  it("preserves JSON API errors received as download streams", async () => {
    const client = new HttpClient({ baseUrl: "http://localhost:31009" }, spec);
    const api = await client["api"];
    api.defaults.adapter = async () => {
      throw {
        response: {
          status: 403,
          statusText: "Forbidden",
          headers: {},
          data: Readable.from([
            JSON.stringify({ code: "forbidden", message: "No access", hint: "Check the space grant" }),
          ]),
        },
      };
    };
    const operation = new OpenAPIToMCPConverter(spec).convertToMCPTools().openApiLookup["API-download-file"];
    await expect(client.executeOperation(operation, { space_id: "space-1", file_id: "file-1" })).rejects.toMatchObject({
      status: 403,
      data: { code: "forbidden", message: "No access", hint: "Check the space grant" },
    });
  });

  it("caps buffering of error streams", async () => {
    const data = Readable.from([Buffer.alloc(65 * 1024)]);
    expect(await readDownloadError(data)).toMatchObject({
      code: "http_error",
      message: expect.stringContaining("64 KiB"),
    });
    expect(data.destroyed).toBe(true);
  });

  it("destroys an aborted download stream", async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    const data = Readable.from([Buffer.from("partial")]);
    await expect(saveDownload(data, { get: () => undefined }, controller.signal)).rejects.toThrow();
    expect(data.destroyed).toBe(true);
  });
});
