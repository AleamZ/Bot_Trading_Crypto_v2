import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FileCursor {
  offset: number;
  /** sha1 of the first HEAD_BYTES of the file when the cursor was written – detects rotation. */
  headHash: string;
  headLength: number;
  ino: string;
  updatedAt: string;
}

export type CursorState = Record<string, FileCursor>;

export interface ReadChunk {
  path: string;
  lines: string[];
  /** Cursor to persist once the chunk has been processed. */
  nextCursor: FileCursor;
  rotated: boolean;
  /** True when MAX_READ_BYTES stopped the read before EOF. */
  truncated: boolean;
}

const HEAD_BYTES = 256;

function readRange(path: string, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function hashHead(path: string, length: number): string {
  if (length <= 0) return "";
  return createHash("sha1").update(readRange(path, 0, length)).digest("hex");
}

/**
 * Reads new complete lines since the cursor. Handles:
 *  - truncation (size < offset) and rotation (head bytes / inode changed) -> restart at 0;
 *  - partial trailing lines (left for the next read);
 *  - a byte budget per read.
 */
export function readNewLines(path: string, cursor: FileCursor | undefined, maxBytes: number): ReadChunk | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path, { bigint: true });
  const size = Number(stat.size);
  const ino = stat.ino.toString();
  let offset = cursor?.offset ?? 0;
  let rotated = false;
  if (cursor) {
    if (size < cursor.offset) rotated = true;
    else if (cursor.ino !== "0" && ino !== "0" && cursor.ino !== ino) rotated = true;
    else if (cursor.headLength > 0 && size >= cursor.headLength && hashHead(path, cursor.headLength) !== cursor.headHash) rotated = true;
    if (rotated) offset = 0;
  }
  const available = Math.max(0, size - offset);
  const toRead = Math.min(available, maxBytes);
  const buffer = toRead > 0 ? readRange(path, offset, toRead) : Buffer.alloc(0);
  const lastNewline = buffer.lastIndexOf(0x0a);
  let consumed = lastNewline >= 0 ? lastNewline + 1 : 0;
  // A single line larger than the budget would block forever – consume it anyway.
  if (consumed === 0 && toRead === maxBytes && toRead > 0) consumed = toRead;
  const text = buffer.subarray(0, consumed).toString("utf8");
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const headLength = Math.min(HEAD_BYTES, size);
  return {
    path,
    lines,
    rotated,
    truncated: available > toRead,
    nextCursor: {
      offset: offset + consumed,
      headHash: hashHead(path, headLength),
      headLength,
      ino,
      updatedAt: new Date().toISOString()
    }
  };
}

export function loadCursorState(file: string): CursorState {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? (value as CursorState) : {};
  } catch {
    return {};
  }
}

export function saveCursorState(file: string, state: CursorState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}
