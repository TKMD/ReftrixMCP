// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Forms the syntactic validator scan does not follow; the type-checker backstop sees each of them.
import { z } from "zod";

import { z as shimmed } from "./zod-shim";

const shapes = { s: z.string() };
export const viaProperty = shapes.s.email();

const mk = (): z.ZodString => z.string();
export const viaReturn = mk().url();

export function viaParameter(s: z.ZodString): z.ZodString {
  return s.uuid();
}

export const viaShim = shimmed.number().int();

const { boolean } = z;
export const viaDestructuring = boolean();

export const viaElement = z.string()["min"](1);

class Holder {
  static s = z.string();
}
export const viaStatic = Holder.s.max(3);

let assigned: z.ZodString;
assigned = z.string();
export const viaAssignment = assigned.length(2);
