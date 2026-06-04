# License Attribution — Prisma Migration Directory

# ライセンス帰属表示 — Prismaマイグレーションディレクトリ

**SPDX-License-Identifier**: AGPL-3.0-only
**SPDX-FileCopyrightText**: 2025–2026 TKMD and Reftrix Contributors
**SPDX Standard Reference**: https://spdx.org/licenses/AGPL-3.0-only.html

---

## License / ライセンス

All SQL migration files in this directory are part of the **Reftrix** project and are licensed under the
**GNU Affero General Public License, Version 3 only (AGPL-3.0-only)**.

このディレクトリに含まれるすべてのSQLマイグレーションファイルは **Reftrix** プロジェクトの一部であり、
**GNU Affero General Public License, Version 3 のみ (AGPL-3.0-only)** のもとでライセンスされています。

The full license text is available at the repository root:
フルライセンステキストはリポジトリルートで参照できます:

```
../../LICENSE
```

This license applies to:
このライセンスは以下に適用されます:

- All existing SQL migration files predating T4-CO-④ (47 files as of 2026-05-05)
- All newly created SQL migration files added after T4-CO-④ lands

T4-CO-④以前の既存SQLマイグレーションファイル（2026-05-05時点で47ファイル）、
およびT4-CO-④ランディング後に追加される新規SQLマイグレーションファイルすべて。

---

## AGPL §5(a) / §5(b) Attribution Preservation Intent

## AGPL §5(a) / §5(b) 帰属保全インテント

The purpose of this marker file is to satisfy **AGPL-3.0 §5(a)/(b) modification notice requirements**
for SQL migration files distributed as part of the Reftrix project.

本マーカーファイルの目的は、Reftrixプロジェクトの一部として配布されるSQLマイグレーションファイルに対する
**AGPL-3.0 §5(a)/(b) 改変通知要件**を満たすことです。

- **§5(a) (license identification)**: Newly created migration files must include
  `-- SPDX-License-Identifier: AGPL-3.0-only` as their **first line** to satisfy
  the license identification requirement.

  **§5(a) (ライセンス識別)**: 新規作成マイグレーションファイルはライセンス識別要件を満たすために、
  最初の行として `-- SPDX-License-Identifier: AGPL-3.0-only` を含まなければなりません。

- **§5(b) (attribution / appropriate legal notices)**: AGPL §5(b) requires that modified
  versions "cause the modified program, when started, to give all users [...] appropriate
  legal notices" including attribution to the original authors. For new migration files,
  developers are encouraged (advisory, not mandatory) to also include:

  **§5(b) (帰属 / 適切な法的通知)**: AGPL §5(b) は改変版が「起動時に、原作者への帰属を含む
  適切な法的通知を全ユーザーに提供する」ことを要求します。新規マイグレーションファイルでは、
  以下も含めることを推奨します（推奨事項、必須ではありません）:

  ```sql
  -- SPDX-License-Identifier: AGPL-3.0-only
  -- Copyright (C) 2026 TKMD — Reftrix contributors
  ```

---

## Prisma Checksum Constraint — Why Existing Files Are Exempt

## Prismaチェックサム制約 — 既存ファイルが適用除外である理由

**CRITICAL**: The 47 existing SQL migration files predating this marker file **must NOT be modified**
(not even to prepend an SPDX header comment).

**重要**: 本マーカーファイル以前の既存47個のSQLマイグレーションファイルは
（SPDXヘッダーコメントの先頭追加を含め）**一切変更してはなりません**。

Prisma computes `_prisma_migrations.checksum` as **SHA-256 of the entire SQL file content**
(including any comments). Modifying any existing migration file — even by prepending a comment —
invalidates the stored checksum in `_prisma_migrations`, causing `prisma migrate deploy` to fail
on all environments where that migration has already been applied.

PrismaはSQLファイルの**全コンテンツ**（コメントを含む）のSHA-256として`_prisma_migrations.checksum`を計算します。
既存マイグレーションファイルへの変更（コメントの先頭追加も含む）は、
`_prisma_migrations`に保存されているチェックサムを無効化し、
そのマイグレーションが適用済みのすべての環境で`prisma migrate deploy`が失敗します。

This marker file itself (`SPDX-LICENSE.md`) is **not a SQL file** and does not affect Prisma checksums.
It provides license context for the directory as a whole, covering both the 47 existing files
(which cannot be individually annotated) and all future new migration files.

本マーカーファイル自体（`SPDX-LICENSE.md`）は **SQLファイルではなく**、Prismaのチェックサムに影響しません。
これは既存の47ファイル（個別注釈不可）と将来の新規マイグレーションファイルの両方をカバーする、
ディレクトリ全体のライセンスコンテキストを提供します。

**Authority**: T4-CO-④ Option A — Registry V1 §7 / Plan V1 §6 / IO Plan Decision V1 anchor `019df88d-445d`.
SEC H-1 originator sign-off granted. LCC M-03 sign-off granted.

**権威**: T4-CO-④ Option A — Registry V1 §7 / Plan V1 §6 / IO Plan Decision V1 アンカー `019df88d-445d`。
SEC H-1 発行元サインオフ承認済み。LCC M-03 サインオフ承認済み。

---

## Convention for NEW Migration Files / 新規マイグレーションファイルの規約

All newly created SQL migration files (created after this PR lands) **must** include
`-- SPDX-License-Identifier: AGPL-3.0-only` as their **first line**.

本PRランディング後に作成される新規SQLマイグレーションファイルはすべて、
**最初の行**として `-- SPDX-License-Identifier: AGPL-3.0-only` を
**含まなければなりません**。

This requirement is enforced by a CI check in `scripts/docs-verify.sh` (Section 16:
SPDX header gate for new migration files).

この要件は `scripts/docs-verify.sh` のCIチェック（セクション16: 新規マイグレーションファイルの
SPDXヘッダーゲート）によって強制されます。

### Required (minimum) / 必須（最小限）

```sql
-- SPDX-License-Identifier: AGPL-3.0-only

-- Your migration SQL here
-- マイグレーションSQLはここに記述
```

### Recommended (advisory) / 推奨（任意）

```sql
-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 TKMD — Reftrix contributors

-- Your migration SQL here
-- マイグレーションSQLはここに記述
```

---

## OSS Sync Propagation / OSS同期伝播

`packages/database/prisma/migrations/` is **included in OSS sync** (not excluded by `.ossfilter`).
This marker file (`SPDX-LICENSE.md`) and any newly created migration files (with SPDX headers)
will propagate to `TKMD/ReftrixMCP` on the next `scripts/sync-oss.sh` cycle.

`packages/database/prisma/migrations/`は**OSS同期の対象**（`.ossfilter`で除外されていません）。
本マーカーファイル（`SPDX-LICENSE.md`）と新規作成マイグレーションファイル（SPDXヘッダー付き）は、
次回の`scripts/sync-oss.sh`サイクルで`TKMD/ReftrixMCP`に伝播します。

Under Option A, no existing file checksums are altered — OSS sync is safe.
Option Aでは既存ファイルのチェックサムは変更されないため、OSS同期は安全です。

---

_Added by T4-CO-④ closure (PR-V3-T4-CO, 2026-05-05)_
_T4-CO-④クロージャーにより追加（PR-V3-T4-CO、2026-05-05）_
