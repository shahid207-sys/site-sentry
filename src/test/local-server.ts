// A tiny HTTP server for tests, plus a fetch policy that lets the SSRF-guarded fetcher reach it on 127.0.0.1.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isBlockedIp } from "../lib/fetch/ip-guard";
import { createSafeFetch, type Fetcher, type FetchPolicy } from "../lib/fetch/safe-fetch";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface LocalServer {
  origin: string;
  port: number;
  routes: Map<string, Handler>;
  /** Request count per path (path + query). */
  hits: Map<string, number>;
  fetch: Fetcher;
  close(): Promise<void>;
}

export async function startLocalServer(routes: Record<string, Handler> = {}): Promise<LocalServer> {
  const table = new Map(Object.entries(routes));
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const key = req.url ?? "/";
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const handler = table.get(key) ?? table.get(key.split("?")[0]);
    if (handler) return handler(req, res);
    res.writeHead(404, { "content-type": "text/html" }).end("<title>Not found</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const policy: FetchPolicy = {
    resolve: async () => ["127.0.0.1"],
    isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedIp(ip)),
    allowedPorts: new Set([String(port)]),
    allowLocalNames: false,
  };
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    routes: table,
    hits,
    fetch: createSafeFetch(policy),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export const send =
  (body: string | Buffer, contentType = "text/html", status = 200, headers: Record<string, string> = {}): Handler =>
  (_req, res) =>
    void res.writeHead(status, { "content-type": contentType, ...headers }).end(body);
