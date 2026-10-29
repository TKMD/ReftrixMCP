// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import zod from "zod";

export const schema = zod.string().startsWith("a");
