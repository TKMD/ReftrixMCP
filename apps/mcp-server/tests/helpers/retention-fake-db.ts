// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal fake of the SQL shapes the screenshot retention cycle issues (told apart by text):
 * the non-canonical count, the candidate select (keyset by id), the row lock re-check
 * (`FOR UPDATE SKIP LOCKED`) and the path NULL-ing. The SQL semantics themselves are pinned on a
 * real DB by the standing tests; this fake pins the cycle's control flow.
 * 保持期限 cycle が発行する SQL の形だけを再現する最小の fake (SQL の意味は実 DB の standing test が固定する)
 */

import type { Prisma } from "@prisma/client";

import type {
  RetentionPrismaClient,
  RetentionTx,
} from "../../src/services/screenshot-retention.service";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pageId(n: number): string {
  return `0192f3a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

export interface FakeRow {
  id: string;
  path: string;
  /** false: the row is no longer eligible when the row lock re-checks it */
  stillEligible: boolean;
  cleared: boolean;
}

export class FakeDb implements RetentionPrismaClient {
  rows: FakeRow[] = [];
  events: string[] = [];
  txOptions: Array<{ maxWait?: number; timeout?: number } | undefined> = [];
  failUpdateFor = new Set<string>();
  candidateQueries = 0;
  /** answer of the non-canonical count query */
  nonCanonicalCount = 0;
  /** runs before the lock re-check of a row (to change the row after it was selected) */
  beforeLock: ((id: string) => void) | undefined;
  /** the Nth candidate select (1-based) throws */
  failCandidateQueryNumber: number | undefined;
  /** every transaction throws */
  failEveryTransaction = false;

  async $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> {
    const text = query.sql;
    const values = query.values as unknown[];
    if (text.includes("count(*)")) return [{ count: this.nonCanonicalCount }] as T;
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      const id = values.find((v) => typeof v === "string" && UUID_RE.test(v)) as string;
      const expectedPath = values.find((v) => typeof v === "string" && v.startsWith("/")) as string;
      this.beforeLock?.(id);
      const row = this.rows.find((r) => r.id === id);
      const ok = row && !row.cleared && row.stillEligible && row.path === expectedPath;
      this.events.push(`lock:${id}:${ok ? "ok" : "none"}`);
      return (ok ? [{ id }] : []) as T;
    }
    this.candidateQueries += 1;
    if (this.failCandidateQueryNumber === this.candidateQueries) throw new Error("select failed");
    const lastId = values.find((v) => typeof v === "string" && UUID_RE.test(v)) as
      | string
      | undefined;
    const limit = values.filter((v) => typeof v === "number").pop() as number;
    return this.rows
      .filter((r) => !r.cleared && (lastId === undefined || r.id > lastId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ id: r.id, path: r.path })) as T;
  }

  async $executeRaw(query: Prisma.Sql): Promise<number> {
    const values = query.values as unknown[];
    const id = values.find((v) => typeof v === "string" && UUID_RE.test(v)) as string;
    if (this.failUpdateFor.has(id)) throw new Error("update failed");
    const row = this.rows.find((r) => r.id === id);
    this.events.push(`update:${id}`);
    if (!row) return 0;
    row.cleared = true;
    return 1;
  }

  async $transaction<R>(
    fn: (tx: RetentionTx) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<R> {
    this.txOptions.push(options);
    if (this.failEveryTransaction) throw new Error("db down");
    return fn(this);
  }
}
