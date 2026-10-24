import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** HTML pages may never be framed (the sign-in page must not be clickjacked). */
/**
 * `forms`: the page posts forms to this origin. `formTargets`: origins those posts may redirect to;
 * Chrome applies CSP form-action to the whole redirect chain of a form submission.
 */
export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  opts: { readonly forms?: boolean; readonly formTargets?: readonly string[]; readonly headers?: Record<string, string> } = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action ${opts.forms ? ["'self'", ...(opts.formTargets ?? [])].join(" ") : "'none'"}`,
    "referrer-policy": "no-referrer",
    ...opts.headers,
  });
  res.end(html);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.authorization ?? "").trim());
  return m ? m[1]! : null;
}

/** Read the body: parsed JSON (default; undefined when empty) or text. Rejects over `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes: number, as: "json" | "text" = "json"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (as === "text") return resolve(text);
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
