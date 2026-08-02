import { deflateSync } from "node:zlib";

const glyphs: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

const crc32 = (data: Buffer) => {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (name: string, data: Buffer) => {
  const type = Buffer.from(name, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
};

export function buildReportPng(input: {
  title: string;
  subtitle: string;
  member: string;
  metric: string;
  progress: number;
}): Buffer {
  const width = 720;
  const height = 960;
  const pixels = Buffer.alloc(width * height * 3);
  const color = (hex: string) =>
    [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const fill = (x: number, y: number, w: number, h: number, hex: string) => {
    const [r, g, b] = color(hex);
    for (let row = Math.max(y, 0); row < Math.min(y + h, height); row += 1) {
      for (
        let column = Math.max(x, 0);
        column < Math.min(x + w, width);
        column += 1
      ) {
        const offset = (row * width + column) * 3;
        pixels[offset] = r!;
        pixels[offset + 1] = g!;
        pixels[offset + 2] = b!;
      }
    }
  };
  const text = (value: string, y: number, scale: number, hex: string) => {
    const normalized = value
      .toUpperCase()
      .replace(/[^A-Z0-9 /:.-]/g, " ")
      .slice(0, 38);
    const textWidth = normalized.length * 6 * scale - scale;
    let x = Math.max(Math.floor((width - textWidth) / 2), 24);
    for (const character of normalized) {
      const glyph = glyphs[character] ?? glyphs[" "]!;
      glyph.forEach((row, rowIndex) =>
        [...row].forEach((pixel, columnIndex) => {
          if (pixel === "1") {
            fill(
              x + columnIndex * scale,
              y + rowIndex * scale,
              scale,
              scale,
              hex,
            );
          }
        }),
      );
      x += 6 * scale;
    }
  };
  fill(0, 0, width, height, "03192A");
  fill(30, 30, width - 60, height - 60, "06111D");
  fill(30, 30, width - 60, 5, "00D9F5");
  fill(30, height - 35, width - 60, 5, "00D9F5");
  fill(width / 2 - 42, 95, 84, 84, "00D9F5");
  text("VF", 120, 5, "03192A");
  text("YOUR VICTORY", 245, 7, "F7F7F7");
  text(input.subtitle, 335, 4, "00D9F5");
  text(input.title, 445, 5, "F7F7F7");
  fill(90, 580, width - 180, 28, "203243");
  fill(
    90,
    580,
    Math.round((width - 180) * Math.min(Math.max(input.progress, 0), 1)),
    28,
    "00D9F5",
  );
  text(input.metric, 660, 4, "A9B8C8");
  fill(110, 755, width - 220, 82, "00C5F0");
  text(input.member || "VICTORY MEMBER", 780, 4, "06131D");
  text("VICTORY-FITNESS.APP", 885, 3, "B1BDCA");

  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 3 + 1);
    rows[target] = 0;
    pixels.copy(rows, target + 1, row * width * 3, (row + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk(
      "tEXt",
      Buffer.from(
        `Report\0${input.title} | ${input.member} | ${input.metric}`,
        "utf8",
      ),
    ),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
