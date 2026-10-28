// A minimal authoritative DNS server on 127.0.0.1 (UDP) for SSRF tests. Answers A and AAAA queries from a
// table; an entry can be a function of the query count, to simulate rebinding. Unknown names get NXDOMAIN.
import { createSocket, type Socket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { ResolveHost } from "../lib/fetch/safe-fetch";

export type Answer = string[] | ((queryNumber: number) => string[]);

export interface DnsStub {
  port: number;
  /** Queries received per lower-cased name (A and AAAA counted separately). */
  queries: Map<string, number>;
  set(name: string, answer: Answer): void;
  /** A resolver that asks only this stub, via node:dns (c-ares), like a real DNS server. */
  resolve: ResolveHost;
  close(): Promise<void>;
}

function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = offset;
  while (buf[i] !== 0) {
    const len = buf[i];
    labels.push(buf.subarray(i + 1, i + 1 + len).toString("ascii"));
    i += len + 1;
  }
  return { name: labels.join(".").toLowerCase(), end: i + 1 };
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(tail === null ? 0 : 8 - h.length - t.length).fill("0"), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

export async function startDnsStub(initial: Record<string, Answer> = {}): Promise<DnsStub> {
  const table = new Map<string, Answer>(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]));
  const queries = new Map<string, number>();
  const socket: Socket = createSocket("udp4");

  socket.on("message", (msg, rinfo) => {
    const id = msg.readUInt16BE(0);
    const { name, end } = readName(msg, 12);
    const qtype = msg.readUInt16BE(end);
    const question = msg.subarray(12, end + 4);
    const n = (queries.get(name) ?? 0) + 1;
    queries.set(name, n);

    const entry = table.get(name);
    const all = entry === undefined ? null : typeof entry === "function" ? entry(n) : entry;
    const wantFamily = qtype === 1 ? 4 : qtype === 28 ? 6 : 0;
    const records = (all ?? []).filter((ip) => isIP(ip) === wantFamily);

    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8400 | (all === null ? 3 : 0), 2); // QR + AA, rcode NXDOMAIN when unknown
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const answers = records.map((ip) => {
      const rdata = wantFamily === 4 ? Buffer.from(ip.split(".").map(Number)) : ipv6Bytes(ip);
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
      rr.writeUInt16BE(qtype, 2);
      rr.writeUInt16BE(1, 4); // class IN
      rr.writeUInt32BE(0, 6); // TTL 0: never cache, so rebinding tests see every answer
      rr.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([rr, rdata]);
    });
    socket.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;

  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([`127.0.0.1:${port}`]);
  const settle = async (p: Promise<string[]>) => {
    try {
      return await p;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw e;
    }
  };

  return {
    port,
    queries,
    set: (name, answer) => void table.set(name.toLowerCase(), answer),
    resolve: async (host) => [...(await settle(resolver.resolve4(host))), ...(await settle(resolver.resolve6(host)))],
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
