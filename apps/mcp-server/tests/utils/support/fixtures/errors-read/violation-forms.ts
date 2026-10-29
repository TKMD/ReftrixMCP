// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fixture for INV-ZOD-ERRORS-READ-ZERO-001: every line marked VIOLATION reads `errors`
// on a ZodError in a different form. The scanner must report exactly the marked lines.
import { z, ZodError } from "zod";

const KEY = "errors" as const;

export function elementAccess(e: ZodError): number {
  return e["errors"].length; // VIOLATION
}

export function computedKey(e: ZodError): number {
  return e[KEY].length; // VIOLATION
}

export function destructure(e: ZodError): number {
  const { errors } = e; // VIOLATION
  return errors.length;
}

export function destructureRenamed(e: ZodError): number {
  const { errors: list } = e; // VIOLATION
  return list.length;
}

export function destructureStringKey(e: ZodError): number {
  const { ["errors"]: list } = e; // VIOLATION
  return list.length;
}

export const parameterPattern = ({ errors }: ZodError): number => errors.length; // VIOLATION

export function forOfPattern(list: ZodError[]): number {
  let n = 0;
  for (const { errors } of list) n += errors.length; // VIOLATION
  return n;
}

export function assignmentPattern(e: ZodError): number {
  let errors: unknown[] = [];
  ({ errors } = e); // VIOLATION
  return errors.length;
}

export function wrapped(e: ZodError | undefined, other: unknown): number {
  const a = e!.errors.length; // VIOLATION
  const b = e?.errors?.length ?? 0; // VIOLATION
  const c = (other as ZodError).errors.length; // VIOLATION
  return a + b + c;
}

export function fromSafeParse(): number {
  const parsed = z.string().safeParse(1);
  if (parsed.success) return 0;
  return parsed.error.errors.length; // VIOLATION
}
