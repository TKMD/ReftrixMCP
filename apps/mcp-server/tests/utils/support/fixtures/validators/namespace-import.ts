// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import * as zod from "zod";

export const a = zod.string().min(1);
export const b = zod.z.number().max(3);
