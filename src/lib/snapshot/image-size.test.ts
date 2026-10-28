import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size";

function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(h * (w * 3 + 1)))), chunk("IEND", Buffer.alloc(0))]);
}

function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0", "latin1"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function webpL(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBPVP8L", 8, "latin1");
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}

describe("imageSize", () => {
  it.each([
    ["png", png(1200, 630)],
    ["gif", gif(1200, 630)],
    ["jpeg", jpeg(1200, 630)],
    ["webp", webpX(1200, 630)],
    ["webp", webpL(1200, 630)],
  ])("reads %s dimensions", (format, buf) => {
    expect(imageSize(buf)).toEqual({ format, width: 1200, height: 630 });
  });

  it("returns null for SVG, truncated or unknown data", () => {
    expect(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).toBeNull();
    expect(imageSize(png(10, 10).subarray(0, 12))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});
