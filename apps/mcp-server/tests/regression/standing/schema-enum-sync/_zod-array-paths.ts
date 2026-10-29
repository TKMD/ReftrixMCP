// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression helper — array positions and bounds, from a runtime Zod 4 schema
 * (`_zod.def`) and from a hand-written JSON Schema (INV-ZOD-ADVERTISED-MAXITEMS-SYNC-001).
 * Positions use the `a.b[].c` form. / 位置は `a.b[].c` 形式。
 */

export interface ArrayBound {
  readonly path: string;
  /** 上限件数。無ければ null / upper bound, null when unbounded */
  readonly max: number | null;
  /** z.array か固定長 z.tuple か / z.array or fixed-length z.tuple */
  readonly kind: "array" | "tuple";
}

interface ZodLike {
  readonly _zod: {
    readonly def: {
      readonly type?: string;
      readonly element?: ZodLike;
      readonly shape?: Readonly<Record<string, ZodLike>>;
      readonly innerType?: ZodLike;
      readonly options?: readonly ZodLike[];
      readonly in?: ZodLike;
      readonly out?: ZodLike;
      readonly left?: ZodLike;
      readonly right?: ZodLike;
      readonly items?: readonly ZodLike[];
      readonly valueType?: ZodLike;
      readonly getter?: () => ZodLike;
      readonly checks?: ReadonlyArray<{
        readonly _zod: { readonly def: { check?: string; maximum?: number; length?: number } };
      }>;
    };
  };
}

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
]);
const LEAVES = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "literal",
  "bigint",
  "date",
  "null",
  "undefined",
  "any",
  "unknown",
  "never",
  "transform",
  "nan",
  "symbol",
  "void",
  "template_literal",
  "file",
  "custom",
]);

const join = (base: string, seg: string): string => (base === "" ? seg : `${base}.${seg}`);
const keyOf = (path: string): string => (path === "" ? "(root)" : path);

/** 複数枝で同じ位置が現れたら、上限なしを優先する (保守側) / an unbounded branch wins (conservative) */
function merge(prev: number | null | undefined, next: number | null): number | null {
  if (prev === undefined) return next;
  return prev === null || next === null ? null : Math.max(prev, next);
}

/**
 * Zod スキーマ内の全 z.array / z.tuple を列挙する。未知の def.type は fail-closed で throw。
 * Enumerates every z.array / z.tuple reachable from a Zod schema; throws on an unknown def type.
 */
export function collectZodArrays(root: unknown): ArrayBound[] {
  const found = new Map<string, { max: number | null; kind: "array" | "tuple" }>();
  const seen = new Set<ZodLike>();

  const record = (path: string, max: number | null, kind: "array" | "tuple"): void => {
    const key = keyOf(path);
    found.set(key, { max: merge(found.get(key)?.max, max), kind });
  };

  const walk = (schema: ZodLike, path: string): void => {
    const def = schema._zod.def;
    const type = def.type ?? "";
    if (type === "array") {
      let max: number | null = null;
      for (const check of def.checks ?? []) {
        const c = check._zod.def;
        const n =
          c.check === "max_length" ? c.maximum : c.check === "length_equals" ? c.length : undefined;
        if (typeof n === "number") max = max === null ? n : Math.min(max, n);
      }
      record(path, max, "array");
      if (def.element) walk(def.element, `${path}[]`);
    } else if (type === "tuple") {
      record(path, (def.items ?? []).length, "tuple");
      for (const item of def.items ?? []) walk(item, `${path}[]`);
    } else if (type === "object") {
      for (const [key, child] of Object.entries(def.shape ?? {})) walk(child, join(path, key));
    } else if (WRAPPERS.has(type) && def.innerType) {
      walk(def.innerType, path);
    } else if (type === "union") {
      for (const option of def.options ?? []) walk(option, path);
    } else if (type === "pipe") {
      for (const side of [def.in, def.out]) if (side) walk(side, path);
    } else if (type === "intersection") {
      for (const side of [def.left, def.right]) if (side) walk(side, path);
    } else if (type === "lazy" && def.getter) {
      const inner = def.getter();
      if (!seen.has(inner)) {
        seen.add(inner);
        walk(inner, path);
      }
    } else if (type === "record") {
      // キー数の上限は別の tracked の範囲。値側の配列だけ辿る / key-count bound is tracked elsewhere
      if (def.valueType) walk(def.valueType, `${path}{}`);
    } else if (!LEAVES.has(type)) {
      throw new Error(`unsupported zod def type at ${keyOf(path)}: ${type || "(none)"}`);
    }
  };

  walk(root as ZodLike, "");
  return [...found.entries()].map(([path, v]) => ({ path, ...v }));
}

interface JsonSchemaLike {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaLike>>;
  readonly items?: JsonSchemaLike;
  readonly maxItems?: number;
  readonly oneOf?: readonly JsonSchemaLike[];
  readonly anyOf?: readonly JsonSchemaLike[];
  readonly allOf?: readonly JsonSchemaLike[];
}

/** 手書き JSON Schema 内の全 `type: "array"` を列挙する / Enumerates every `type: "array"` */
export function collectJsonArrays(root: unknown): ArrayBound[] {
  const found = new Map<string, number | null>();
  const walk = (schema: JsonSchemaLike, path: string): void => {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("array") || schema.items !== undefined) {
      const key = keyOf(path);
      found.set(key, merge(found.get(key), schema.maxItems ?? null));
      if (schema.items) walk(schema.items, `${path}[]`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      walk(child, join(path, key));
    for (const branch of [
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
      ...(schema.allOf ?? []),
    ]) {
      walk(branch, path);
    }
  };
  walk(root as JsonSchemaLike, "");
  return [...found.entries()].map(([path, max]) => ({ path, max, kind: "array" as const }));
}
