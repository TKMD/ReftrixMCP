# MCP Server 認証機構 要件定義書 / MCP Server Authentication Requirements

**Version**: 2.0.0
**Last Updated**: 2026-03-01
**Status**: Released
**Author**: Requirements Architect

---

## 1. 概要 / Overview

### 1.1 背景 / Background

SEC監査において「MCP Server認証機構の欠如」がHigh優先度で指摘された。

The SEC audit flagged "Missing MCP Server authentication mechanism" as a High priority issue.

| 項目 / Item | 値 / Value |
|------|-----|
| CVSS Score | 7.5 (High) |
| CWE | CWE-306 (Missing Authentication for Critical Function) |
| 対象ファイル / Target Files | `src/router.ts`, `src/index.ts` |

### 1.2 現状の問題 / Current Problem

```typescript
// src/router.ts - 現状の実装 / Current implementation
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // 認証・認可チェックなしでツールを直接実行
  // Tools are executed directly without authentication or authorization checks
  const handler = toolHandlers.get(toolName);
  return handler(args);
}
```

**問題点 / Issues**:
- `handleToolCall()`が認証なしでツールを直接呼び出している / `handleToolCall()` invokes tools directly without authentication
- ネットワーク経由アクセス時に不正なツール実行リスクがある / Risk of unauthorized tool execution when accessed over the network
- ツール別のアクセス制御が存在しない / No per-tool access control exists

---

## 2. 認証方式 / Authentication Method

### 2.1 採用: APIキー認証 / Adopted: API Key Authentication

**Phase 1: APIキー認証（即座に実装可能） / Phase 1: API Key Authentication (immediately implementable)**
- シンプルな環境変数ベースの認証 / Simple environment variable-based authentication
- MCPプロトコルのヘッダー拡張で対応 / Handled via MCP protocol header extensions
- 即座にセキュリティリスクを軽減 / Immediately mitigates security risk

---

## 3. 認可（ACL）設計 / Authorization (ACL) Design

### 3.1 パーミッション定義（WebDesign専用） / Permission Definitions (WebDesign-dedicated)

```typescript
export const PERMISSIONS = {
  // システム系 / System
  SYSTEM_READ: 'system:read',
  SYSTEM_HEALTH: 'system:health',
  SYSTEM_ADMIN: 'system:admin',
  // レイアウト系 / Layout
  LAYOUT_READ: 'layout:read',
  LAYOUT_WRITE: 'layout:write',
  LAYOUT_TRANSFORM: 'layout:transform',
  // モーション系 / Motion
  MOTION_READ: 'motion:read',
  MOTION_TRANSFORM: 'motion:transform',
  // 品質系 / Quality
  QUALITY_READ: 'quality:read',
  QUALITY_WRITE: 'quality:write',
  // プロジェクト系 / Project
  PROJECT_READ: 'project:read',
  // デザイン系 / Design
  DESIGN_REVIEW: 'design:review',
  DESIGN_WRITE: 'design:write',
  // スタイル系 / Style
  STYLE_READ: 'style:read',
} as const;
```

### 3.2 ツール-パーミッション マッピング / Tool-Permission Mapping

```typescript
export const TOOL_PERMISSIONS: Record<string, Permission[]> = {
  // スタイル系 / Style
  'style.get_palette': [PERMISSIONS.STYLE_READ],

  // レイアウト系 / Layout
  'layout.inspect': [PERMISSIONS.LAYOUT_READ],
  'layout.search': [PERMISSIONS.LAYOUT_READ],
  'layout.ingest': [PERMISSIONS.LAYOUT_WRITE],
  'layout.generate_code': [PERMISSIONS.LAYOUT_TRANSFORM],

  // 品質系 / Quality
  'quality.evaluate': [PERMISSIONS.QUALITY_READ],
  'quality.batch_evaluate': [PERMISSIONS.QUALITY_READ],

  // モーション系 / Motion
  'motion.detect': [PERMISSIONS.MOTION_READ],
  'motion.search': [PERMISSIONS.MOTION_READ],

  // ブリーフ系（デザインレビュー） / Brief (Design Review)
  'brief.validate': [PERMISSIONS.DESIGN_REVIEW],

  // プロジェクト系 / Project
  'project.get': [PERMISSIONS.PROJECT_READ],
  'project.list': [PERMISSIONS.PROJECT_READ],

  // ページ系（統合Web分析） / Page (Unified Web Analysis)
  'page.analyze': [PERMISSIONS.LAYOUT_READ, PERMISSIONS.MOTION_READ, PERMISSIONS.QUALITY_READ],
  'page.getJobStatus': [PERMISSIONS.LAYOUT_READ],

  // システム系（公開ツール） / System (Public Tools)
  'system.health': [PERMISSIONS.SYSTEM_HEALTH],
};
```

### 3.3 ロール定義 / Role Definitions

```typescript
export const ROLES = {
  // 読み取り専用（閲覧者） / Read-only (Viewer)
  VIEWER: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.STYLE_READ,
  ],

  // 標準ユーザー（読み取り + 変換） / Standard User (Read + Transform)
  USER: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.LAYOUT_TRANSFORM,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.MOTION_TRANSFORM,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.QUALITY_WRITE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.DESIGN_REVIEW,
    PERMISSIONS.STYLE_READ,
  ],

  // 管理者（全権限） / Admin (All Permissions)
  ADMIN: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.SYSTEM_ADMIN,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.LAYOUT_WRITE,
    PERMISSIONS.LAYOUT_TRANSFORM,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.MOTION_TRANSFORM,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.QUALITY_WRITE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.DESIGN_REVIEW,
    PERMISSIONS.DESIGN_WRITE,
    PERMISSIONS.STYLE_READ,
  ],
} as const;
```

---

## 4. 環境変数設計 / Environment Variable Design

```bash
# 認証の有効化（オプトイン方式） / Enable authentication (opt-in)
MCP_AUTH_ENABLED=true

# 認証方式（api_key | jwt） / Authentication method (api_key | jwt)
MCP_AUTH_METHOD=api_key

# APIキー設定（JSON形式） / API key configuration (JSON format)
MCP_API_KEYS='[{"id":"default","keyHash":"$2b$10$...","role":"ADMIN"}]'

# 公開ツール（カンマ区切り） / Public tools (comma-separated)
MCP_PUBLIC_TOOLS=system.health
```

---

## 5. エラーレスポンス設計 / Error Response Design

### 5.1 認証エラー / Authentication Error

```typescript
// UNAUTHORIZED (401相当 / 401 equivalent)
{
  isError: true,
  content: [{
    type: 'text',
    text: 'Error: UNAUTHORIZED - Authentication required'
  }]
}
```

### 5.2 認可エラー / Authorization Error

```typescript
// FORBIDDEN (403相当 / 403 equivalent)
{
  isError: true,
  content: [{
    type: 'text',
    text: 'Error: UNAUTHORIZED - Insufficient permissions for tool: layout.ingest'
  }]
}
```

---

## 6. 関連ドキュメント / Related Documents

- SECURITY.md - セキュリティ要件 / Security requirements

---

