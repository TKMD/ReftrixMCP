// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

const builder = { make: () => builder, build: () => builder };

export const a = builder.make().build();
