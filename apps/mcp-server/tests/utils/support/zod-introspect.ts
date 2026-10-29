// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read a zod schema's structure the same way on zod 3 and zod 4. zod 3 keeps the kind in
 * `_def.typeName` ("ZodOptional") and wraps a refinement in ZodEffects; zod 4 keeps it in
 * `_zod.def.type` ("optional"), puts a refinement on the schema itself and wraps a transform in a
 * "pipe" (`def.in`).
 */

export type ZodKind =
  | "optional"
  | "default"
  | "wrapper"
  | "boolean"
  | "number"
  | "array"
  | "object"
  | "other";

interface DefLike {
  typeName?: string;
  type?: string;
  innerType?: unknown;
  schema?: unknown;
  in?: unknown;
  defaultValue?: unknown;
}

const KINDS: Record<string, ZodKind> = {
  // zod 3 typeName
  ZodOptional: "optional",
  ZodDefault: "default",
  ZodEffects: "wrapper",
  ZodBoolean: "boolean",
  ZodNumber: "number",
  ZodArray: "array",
  ZodObject: "object",
  // zod 4 type
  optional: "optional",
  default: "default",
  pipe: "wrapper",
  boolean: "boolean",
  number: "number",
  array: "array",
  object: "object",
};

function defOf(schema: unknown): DefLike | undefined {
  const s = schema as { _zod?: { def?: DefLike }; _def?: DefLike } | undefined;
  return s?._zod?.def ?? s?._def;
}

export function zodKind(schema: unknown): ZodKind {
  const def = defOf(schema);
  return KINDS[def?.typeName ?? def?.type ?? ""] ?? "other";
}

/** The schema inside an optional / default / refine-or-transform wrapper (undefined when none). */
export function zodInner(schema: unknown): unknown {
  const def = defOf(schema);
  const kind = zodKind(schema);
  if (kind === "optional" || kind === "default") return def?.innerType;
  return kind === "wrapper" ? (def?.schema ?? def?.in ?? def?.innerType) : undefined;
}

/** Strip every optional / default / wrapper layer. */
export function zodUnwrap(schema: unknown): unknown {
  let cur = schema;
  for (let inner = zodInner(cur); inner !== undefined; inner = zodInner(cur)) cur = inner;
  return cur;
}

/** The value a default schema fills in (zod 3 stores a function, zod 4 a value). */
export function zodDefaultValue(schema: unknown): unknown {
  const dv = defOf(schema)?.defaultValue;
  return typeof dv === "function" ? (dv as () => unknown)() : dv;
}

export function zodObjectShape(schema: unknown): Record<string, unknown> {
  return (schema as { shape?: Record<string, unknown> }).shape ?? {};
}

/** Declared min / max of a number schema (zod 4's safe-integer range for `.int()` reads as absent). */
export function zodNumberBounds(schema: unknown): { minimum?: number; maximum?: number } {
  const n = schema as { minValue?: number | null; maxValue?: number | null };
  const out: { minimum?: number; maximum?: number } = {};
  if (typeof n.minValue === "number" && n.minValue !== Number.MIN_SAFE_INTEGER) {
    out.minimum = n.minValue;
  }
  if (typeof n.maxValue === "number" && n.maxValue !== Number.MAX_SAFE_INTEGER) {
    out.maximum = n.maxValue;
  }
  return out;
}
