// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { formatZodError } from "../../../../../src/utils/error-messages";

export const fromCall = (e: Parameters<typeof formatZodError>[0]): unknown => formatZodError(e);
