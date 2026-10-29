// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

const base = z.string();
const longer = base.email();
export const a = longer.max(9);
export const result = a.safeParse("x");
export const texts = result.success ? [] : result.error.issues.map((i) => i.message);
