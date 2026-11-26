// What the proxy may quote from an HTTP error body. Only Anytype's own error
// shapes are recognised, only their documented fields are kept, every quoted
// string is bounded and stripped of control characters, and the configured
// credentials are redacted from it: a gateway or a misbehaving server could
// otherwise put a reflected Authorization header into a tool result.

import { isObject } from "./jsonrpc";

export interface AnytypeError {
  code: string;
  message: string;
  issues?: Array<{ path?: string; message: string }>;
}

/**
 * Anytype's error bodies: util.CodeToApiError ({object:"error", status, code,
 * message}) and the v2 envelope ({status, code, message, issues}). Anything
 * else is not quoted at all.
 */
export function anytypeError(
  body: unknown,
  status: number,
  redact: (text: string) => string,
): AnytypeError | undefined {
  if (!isObject(body) || typeof body.code !== "string" || typeof body.message !== "string") return undefined;
  if (body.object !== undefined && body.object !== "error") return undefined;
  // both Anytype shapes always carry the status; a body without it is not Anytype's
  if (body.status !== status) return undefined;
  const error: AnytypeError = { code: bounded(body.code, 100, redact), message: bounded(body.message, 500, redact) };
  if (Array.isArray(body.issues)) {
    error.issues = body.issues
      .filter((issue): issue is Record<string, unknown> => isObject(issue) && typeof issue.message === "string")
      .slice(0, 20)
      .map((issue) => ({
        ...(typeof issue.path === "string" ? { path: bounded(issue.path, 200, redact) } : {}),
        message: bounded(issue.message as string, 300, redact),
      }));
  }
  return error;
}

function bounded(value: string, limit: number, redact: (text: string) => string): string {
  // eslint-disable-next-line no-control-regex
  const text = redact(value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim());
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Headers whose values are not credentials. */
const PUBLIC_HEADERS = new Set(["anytype-version"]);

/** Replaces each configured header value, and a bearer's bare token, wherever it appears. */
export function redactor(headers: Record<string, string>): (text: string) => string {
  const secrets = new Set<string>();
  for (const [name, raw] of Object.entries(headers)) {
    if (PUBLIC_HEADERS.has(name.toLowerCase())) continue;
    const value = raw.trim();
    if (value.length >= 4) secrets.add(value);
    const token = /^bearer\s+(.+)$/i.exec(value)?.[1]?.trim();
    if (token && token.length >= 4) secrets.add(token);
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}
