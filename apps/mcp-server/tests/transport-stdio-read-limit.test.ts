// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * stdio 受信上限の特性 test (CO-R2-97、unit、Regression domain: none)
 *
 * `@modelcontextprotocol/sdk` 1.30.0 以降の `StdioServerTransport` は 1 行あたりの受信 buffer に
 * 既定上限 10,485,760 B を持ち、超えると `onerror` を呼んで transport を close する (以後の行は
 * 届かない)。Reftrix の `createTransport()` は第 3 引数なし (= 既定上限) で生成するため、同じ形で
 * 生成した transport に PassThrough stream を渡し、境界の両側 (9,000,093 B / 11,000,093 B の行)
 * の挙動を pin する。sdk の次回更新で境界が変わると本 test が RED になる。
 * process の終了 / 残存は env 依存のため assert しない (transport 単位の test)。
 *
 * Characterizes the default stdio read limit of `StdioServerTransport` (sdk >= 1.30.0): a line
 * above 10,485,760 B triggers `onerror` and closes the transport, so later lines never arrive.
 * The transport is built like Reftrix's `createTransport()` (no third argument = default limit)
 * over PassThrough streams, and both sides of the boundary are pinned. Process exit or survival
 * is env-dependent and deliberately not asserted.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as sdkStdioShared from "@modelcontextprotocol/sdk/shared/stdio.js";

/** sdk 1.31.0 の `STDIO_DEFAULT_MAX_BUFFER_SIZE` (10 MiB) / the sdk default read limit */
const READ_LIMIT_BYTES = 10_485_760;
/** export が無い版 (1.26.0) では undefined / undefined on versions without the export */
const SDK_DEFAULT_MAX_BUFFER_SIZE: unknown = (sdkStdioShared as Record<string, unknown>)
  .STDIO_DEFAULT_MAX_BUFFER_SIZE;
const CHUNK = 65_536;
const WAIT_MS = 10_000;

interface Harness {
  transport: StdioServerTransport;
  stdin: PassThrough;
  messages: unknown[];
  errors: Error[];
  isClosed: () => boolean;
}

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin, stdout);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let closed = false;
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => {
    closed = true;
  };
  await transport.start();
  const harness = { transport, stdin, messages, errors, isClosed: () => closed };
  harnesses.push(harness);
  return harness;
}

/** `tools/call` 1 行 (html = `a` × payloadBytes)。改行込みの byte 数 = payloadBytes + 93 */
function toolsCallLine(payloadBytes: number): string {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "x", arguments: { html: "a".repeat(payloadBytes) } },
  };
  return `${JSON.stringify(request)}\n`;
}

function writeChunked(stdin: PassThrough, line: string): void {
  for (let i = 0; i < line.length; i += CHUNK) stdin.write(line.slice(i, i + CHUNK));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pingLine = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`;

afterEach(async () => {
  for (const { transport, stdin } of harnesses.splice(0)) {
    stdin.end();
    await transport.close();
  }
});

describe("StdioServerTransport の既定受信上限 / default stdio read limit", () => {
  it("9,000,093 B の行 + ping → 2 message を受信し close しない", async () => {
    const line = toolsCallLine(9_000_000);
    expect(Buffer.byteLength(line)).toBe(9_000_093);
    expect(Buffer.byteLength(line)).toBeLessThan(READ_LIMIT_BYTES);
    const h = await startHarness();
    writeChunked(h.stdin, line);
    h.stdin.write(pingLine);
    await waitFor(() => h.messages.length >= 2);
    expect(h.messages).toHaveLength(2);
    expect(h.errors).toEqual([]);
    expect(h.isClosed()).toBe(false);
  });

  it("11,000,093 B の行 + ping → onerror の後に close し、後続の ping は届かない", async () => {
    const line = toolsCallLine(11_000_000);
    expect(Buffer.byteLength(line)).toBe(11_000_093);
    expect(Buffer.byteLength(line)).toBeGreaterThan(READ_LIMIT_BYTES);
    // 境界の根拠: export がある版ではリテラルと一致すること / the export, when present, matches
    expect([undefined, READ_LIMIT_BYTES]).toContain(SDK_DEFAULT_MAX_BUFFER_SIZE);
    const h = await startHarness();
    writeChunked(h.stdin, line);
    h.stdin.write(pingLine);
    await waitFor(() => h.isClosed() || h.messages.length >= 2);
    // close 後に ping が遅れて届かないことを見るための猶予 / settle so a late ping would show
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.isClosed()).toBe(true);
    expect(h.messages).toHaveLength(0);
  });
});
