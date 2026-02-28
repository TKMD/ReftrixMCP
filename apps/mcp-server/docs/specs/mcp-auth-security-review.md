# MCP Server 認証機構セキュリティレビュー / MCP Server Authentication Security Review

**Version**: 1.0.0
**作成日 / Created**: 2026-03-01
**監査対応 / Audit Response**: SEC監査 High優先度指摘 / SEC audit High priority finding（CVSS 7.5, CWE-306）

---

## 1. Executive Summary

### 1.1 現状評価 / Current Assessment

| 項目 / Item | 評価 / Rating | 説明 / Description |
|------|------|------|
| **認証機構 / Authentication** | 実装済み / Implemented | APIキー認証（`MCP_AUTH_ENABLED=true` で有効化） / API key authentication (enable with `MCP_AUTH_ENABLED=true`) |
| **認可機構 / Authorization** | 部分実装 / Partially Implemented | RBAC 3ロール: VIEWER/USER/ADMIN / RBAC with 3 roles: VIEWER/USER/ADMIN |
| **監査ログ / Audit Logs** | 部分的 / Partial | ツール呼び出しログのみ / Tool call logs only |
| **レート制限 / Rate Limiting** | 未実装 / Not implemented | DoS攻撃に対する防御なし / No defense against DoS attacks |

### 1.2 リスクサマリー / Risk Summary

**脆弱性識別子**: CWE-306 (Missing Authentication for Critical Function)
**CVSS Score**: 7.5 (High)
**OWASP分類**: A07:2021 Identification and Authentication Failures

### 1.3 推奨対応優先度 / Recommended Response Priority

| 対策 / Countermeasure | 優先度 / Priority | 実装目標 / Implementation Target |
|------|--------|---------|
| 認証ミドルウェア追加 / Add auth middleware | Critical | 7日以内 / Within 7 days |
| レート制限実装 / Implement rate limiting | High | 14日以内 / Within 14 days |
| 監査ログ強化 / Enhance audit logs | Medium | 30日以内 / Within 30 days |
| 認可機構（RBAC） / Authorization (RBAC) | Medium | 30日以内 / Within 30 days |

---

## 2. 現状コード分析 / Current Code Analysis

### 2.1 認証フローの欠如 / Lack of Authentication Flow

**ファイル**: `apps/mcp-server/src/server.ts`

```typescript
// 現在の実装: 認証チェックなし / Current implementation: No authentication check
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // ここに認証チェックがない / No authentication check here
  const result = await handleToolCall(name, args || {});
  // ...
});
```

**問題点 / Issues**:
- リクエストを受け付ける前に認証検証がない / No authentication validation before accepting requests
- 任意のクライアントがツールを実行可能 / Any client can execute tools
- セッション管理の概念がない / No concept of session management

### 2.2 ルーター層の分析 / Router Layer Analysis

**ファイル**: `apps/mcp-server/src/router.ts`

```typescript
// 監査レビュー時点の実装: 認証コンテキストなし / Implementation at time of audit: No auth context
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // 認証情報を受け取らない / Does not receive auth info
  // 認可チェックなし / No authorization check
  const handler = toolHandlers.get(toolName);
  // ...
}
```

> **更新 (Phase 1実装完了後)**: `handleToolCall` は5引数（`toolName`, `args`, `apiKey?`, `requestId?`, `progressContext?`）に更新済みです。APIキー認証が `MCP_AUTH_ENABLED=true` 時に適用されます。
>
> **Update (Post Phase 1)**: `handleToolCall` has been updated to accept 5 arguments (`toolName`, `args`, `apiKey?`, `requestId?`, `progressContext?`). API key authentication is enforced when `MCP_AUTH_ENABLED=true`.

**問題点（監査時点） / Issues (At Time of Audit)**:
- 認証コンテキストがハンドラーに渡されない / Auth context is not passed to handlers
- ツールごとの権限チェックができない / Per-tool permission checks are not possible

### 2.3 トランスポート層の分析 / Transport Layer Analysis

**ファイル**: `apps/mcp-server/src/transport.ts`

現在はStdIO（標準入出力）トランスポートのみサポート。

Currently only StdIO (standard I/O) transport is supported.

```typescript
export function createTransport(): StdioServerTransport {
  const transport = new StdioServerTransport();
  return transport;
}
```

**StdIOトランスポートの特性 / StdIO Transport Characteristics**:
- Claude Desktop等のローカルクライアントとの通信用 / For communication with local clients such as Claude Desktop
- プロセス間通信（stdin/stdout） / Inter-process communication (stdin/stdout)
- ネットワーク越しのアクセスは不可（直接的には） / No network access (directly)

---

## 3. 脅威モデル分析 / Threat Model Analysis

### 3.1 攻撃シナリオ / Attack Scenarios

#### シナリオ1: ローカル権限昇格 / Scenario 1: Local Privilege Escalation

```
攻撃者（ローカルユーザー）
  → MCPサーバープロセスにアクセス
  → 任意のツール実行
  → データベースアクセス/データ漏洩
```

**可能性 / Likelihood**: 中 / Medium（マルチユーザー環境で発生 / Occurs in multi-user environments）
**影響度 / Impact**: 高 / High（全データアクセス可能 / All data accessible）

#### シナリオ2: 悪意のあるMCPクライアント / Scenario 2: Malicious MCP Client

```
悪意のあるMCPクライアント
  → 正規サーバーに接続
  → 制限なくツール実行
  → リソース枯渇/データ改竄
```

**可能性 / Likelihood**: 中 / Medium（MCP設定の改竄で発生 / Occurs via MCP config tampering）
**影響度 / Impact**: 高 / High

#### シナリオ3: サプライチェーン攻撃 / Scenario 3: Supply Chain Attack

```
悪意のある依存パッケージ
  → MCPサーバー起動時に実行
  → 認証なしでツール呼び出し
  → バックドア設置
```

**可能性 / Likelihood**: 低 / Low（依存関係管理で軽減 / Mitigated by dependency management）
**影響度 / Impact**: 致命的 / Critical

### 3.2 攻撃対象となる機能 / Target Functions

| 機能カテゴリ / Function Category | ツール例 / Tool Examples | リスク評価 / Risk Rating |
|-------------|---------|-----------|
| レイアウトデータアクセス / Layout data access | layout.inspect, layout.search | High |
| レイアウト変更操作 / Layout modification | layout.ingest, layout.generate_code | Critical |
| システム情報 / System information | system.health | Medium |
| プロジェクト管理 / Project management | project.get, project.list | High |
| 一括操作 / Bulk operations | quality.batch_evaluate | High |

---

## 4. MCP認証仕様（2025年6月版） / MCP Authentication Specification (June 2025)

### 4.1 OAuth 2.1 要件 / OAuth 2.1 Requirements

MCP仕様（2025-03-26、2025-06-18更新）では、OAuth 2.1に基づく認証を規定。

The MCP specification (2025-03-26, updated 2025-06-18) defines authentication based on OAuth 2.1.

**必須要件 / Required**:
- OAuth 2.1 with PKCE（全クライアント必須）
- Bearer Token認証
- TLS必須（HTTPSトランスポート時）
- RFC 9728 Protected Resource Metadata対応

**参照**: [MCP Authorization Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)

### 4.2 トランスポート別考慮事項 / Transport-Specific Considerations

| トランスポート / Transport | 認証方式 / Auth Method | 適用性 / Applicability |
|---------------|---------|--------|
| StdIO | プロセス分離 / Process isolation | 現在使用中 / Currently in use |
| HTTP/SSE | OAuth 2.1 Bearer | 将来的に追加検討 / Future consideration |
| WebSocket | OAuth 2.1 Bearer | 将来的に追加検討 / Future consideration |

### 4.3 StdIOトランスポートの特殊性 / StdIO Transport Specifics

StdIOトランスポートは以下の特性を持つ:

StdIO transport has the following characteristics:

1. **プロセス境界による保護 / Process boundary protection**: MCPサーバーは親プロセス（Claude Desktop等）から起動 / MCP server is launched by parent process (Claude Desktop, etc.)
2. **認証の暗黙的委任 / Implicit auth delegation**: 親プロセスの認証を継承 / Inherits parent process authentication
3. **ネットワーク非露出 / No network exposure**: 直接のネットワークアクセス不可 / No direct network access

**ただし、これは十分な保護ではない / However, this is not sufficient protection**:
- 親プロセスが侵害された場合、認証バイパス / Auth bypass if parent process is compromised
- マルチユーザー環境での権限分離が不十分 / Insufficient privilege separation in multi-user environments
- 監査証跡が残らない / No audit trail

---

## 5. 認証方式の比較 / Authentication Method Comparison

### 5.1 方式比較表 / Method Comparison Table

| 方式 / Method | セキュリティ / Security | 実装コスト / Impl. Cost | 運用コスト / Ops Cost | MCP適合性 / MCP Compatibility |
|------|------------|-----------|-----------|-----------|
| **APIキー / API Key** | 中 / Medium | 低 / Low | 低 / Low | 部分的 / Partial |
| **JWT** | 高 / High | 中 / Medium | 中 / Medium | 高 / High |
| **OAuth 2.1** | 最高 / Highest | 高 / High | 高 / High | 完全 / Full |
| **mTLS** | 最高 / Highest | 高 / High | 高 / High | 部分的 / Partial |

### 5.2 APIキー認証 / API Key Authentication

**メリット / Pros**:
- 実装が単純 / Simple implementation
- 開発環境での利用に適切 / Suitable for development environments
- 設定ファイル（.mcp.json）で管理可能 / Manageable via config file (.mcp.json)

**デメリット / Cons**:
- キーローテーションが手動 / Manual key rotation
- 漏洩時の影響範囲が大きい / Large impact scope on leakage
- 細かい権限制御が困難 / Difficult fine-grained permission control

**推奨用途 / Recommended Use**: 開発/ステージング環境 / Development/staging environments

```typescript
// 実装例
interface AuthConfig {
  apiKey?: string;
  requiredScopes?: string[];
}

function validateApiKey(request: Request, config: AuthConfig): boolean {
  const providedKey = request.headers.get('X-API-Key');
  return providedKey === config.apiKey;
}
```

### 5.3 JWT認証 / JWT Authentication

**メリット / Pros**:
- ステートレス認証 / Stateless authentication
- クレーム（claims）による権限制御 / Permission control via claims
- 有効期限の自動管理 / Automatic expiration management
- 外部システムとの統合が容易 / Easy integration with external systems

**デメリット / Cons**:
- トークン更新の仕組みが必要 / Token refresh mechanism required
- 秘密鍵管理が必要 / Secret key management required
- StdIOトランスポートでの伝達方法要検討 / Transmission method via StdIO transport needs consideration

**推奨用途 / Recommended Use**: 本番環境、外部システム連携 / Production environments, external system integration

```typescript
// 実装例
interface JWTClaims {
  sub: string;      // ユーザーID
  email: string;
  roles: string[];  // ['admin', 'editor', 'viewer']
  exp: number;      // 有効期限
  aud: string;      // 'reftrix-mcp-server'
}

async function validateJWT(token: string): Promise<JWTClaims> {
  // jose ライブラリで検証
  const { payload } = await jwtVerify(token, publicKey, {
    audience: 'reftrix-mcp-server',
    issuer: 'https://(your-auth-domain)',
  });
  return payload as JWTClaims;
}
```

### 5.4 推奨アプローチ / Recommended Approach

**フェーズ1（即座） / Phase 1 (Immediate)**: APIキー + 環境変数 / API Key + Environment Variables
**フェーズ2（30日以内） / Phase 2 (Within 30 days)**: JWT認証 / JWT Authentication
**フェーズ3（将来） / Phase 3 (Future)**: OAuth 2.1（HTTPトランスポート追加時 / When HTTP transport is added）

---

## 6. 推奨セキュリティ要件 / Recommended Security Requirements

### 6.1 認証バイパス防止 / Authentication Bypass Prevention

```typescript
// router.ts への変更案
export interface AuthContext {
  userId?: string;
  roles: string[];
  isAuthenticated: boolean;
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  auth: AuthContext  // 認証コンテキストを追加
): Promise<unknown> {
  // 認証チェック
  if (!auth.isAuthenticated) {
    throw new McpError(ErrorCode.UNAUTHORIZED, 'Authentication required');
  }

  // 認可チェック
  if (!hasPermission(toolName, auth.roles)) {
    throw new McpError(ErrorCode.UNAUTHORIZED, 'Insufficient permissions');
  }

  // ... 既存処理
}
```

### 6.2 レート制限 / Rate Limiting

```typescript
// middleware/rate-limiter.ts
interface RateLimitConfig {
  windowMs: number;      // ウィンドウサイズ（ミリ秒）
  maxRequests: number;   // 最大リクエスト数
  keyGenerator: (req: Request) => string;  // キー生成関数
}

const defaultConfig: RateLimitConfig = {
  windowMs: 60_000,      // 1分
  maxRequests: 100,      // 100リクエスト/分
  keyGenerator: (req) => req.auth?.userId || 'anonymous',
};

// ツール別のレート制限
const toolRateLimits: Record<string, RateLimitConfig> = {
  'layout.ingest': { windowMs: 60_000, maxRequests: 30, ... },
  'quality.batch_evaluate': { windowMs: 300_000, maxRequests: 10, ... },
};
```

### 6.3 監査ログ / Audit Logs

```typescript
// 必須記録項目 / Required log fields
interface AuditLogEntry {
  timestamp: string;      // ISO 8601
  eventType: 'tool_call' | 'auth_success' | 'auth_failure' | 'rate_limit';
  toolName?: string;
  userId?: string;
  clientId?: string;
  ipAddress?: string;
  success: boolean;
  errorCode?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

// 開発環境ログ例 / Development environment log example
logger.info('[Security] Tool call authorized', {
  tool: 'layout.search',
  userId: 'user-123',
  roles: ['editor'],
  timestamp: new Date().toISOString(),
});
```

### 6.4 ロールベースアクセス制御（RBAC） / Role-Based Access Control (RBAC)

```typescript
// types/auth.ts
export enum Role {
  ADMIN = 'admin',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

// ツール別権限マトリクス
export const toolPermissions: Record<string, Role[]> = {
  // 読み取り専用（全ロール） / Read-only (all roles)
  'layout.search': [Role.ADMIN, Role.EDITOR, Role.VIEWER],
  'layout.inspect': [Role.ADMIN, Role.EDITOR, Role.VIEWER],
  'motion.detect': [Role.ADMIN, Role.EDITOR, Role.VIEWER],
  'system.health': [Role.ADMIN, Role.EDITOR, Role.VIEWER],

  // 編集権限必要 / Edit permission required
  'layout.ingest': [Role.ADMIN, Role.EDITOR],
  'layout.generate_code': [Role.ADMIN, Role.EDITOR],

  // 管理者のみ / Admin only
  'quality.batch_evaluate': [Role.ADMIN],
  'project.delete': [Role.ADMIN],
};
```

---

## 7. 実装ロードマップ / Implementation Roadmap

### Phase 1: 緊急対応（7日以内） / Phase 1: Urgent Response (Within 7 Days)

**目標 / Goal**: 認証の基本実装 / Basic authentication implementation

| タスク / Task | 担当 / Owner | 完了基準 / Done Criteria |
|--------|------|---------|
| APIキー認証ミドルウェア / API key auth middleware | Security | 環境変数から読み取り / Read from env vars |
| server.ts 認証統合 / server.ts auth integration | Security | 全ツール呼び出しで検証 / Verified for all tool calls |
| 認証失敗時のエラー応答 / Auth failure error response | Security | MCP形式準拠 / MCP format compliant |
| 開発環境バイパスオプション / Dev env bypass option | Security | NODE_ENV=development |

**環境変数設計 / Environment Variable Design**:
<!-- NOTE: Phase 1実装では MCP_API_KEYS（複数形、カンマ区切り）に変更済み。以下は設計時の記載。 -->
```bash
# .env.example
MCP_AUTH_ENABLED=true
MCP_API_KEY=your-secret-api-key-here
MCP_AUTH_BYPASS_DEV=false  # 開発環境でも認証必須にする場合
```

### Phase 2: レート制限（14日以内） / Phase 2: Rate Limiting (Within 14 Days)

**目標 / Goal**: DoS防御 / DoS defense

| タスク / Task | 担当 / Owner | 完了基準 / Done Criteria |
|--------|------|---------|
| レート制限ミドルウェア / Rate limiting middleware | Security | インメモリカウンター / In-memory counter |
| ツール別制限設定 / Per-tool limit config | Security | bulk操作に厳格制限 / Strict limits on bulk operations |
| 429応答実装 / 429 response implementation | Security | Retry-Afterヘッダー / Retry-After header |

### Phase 3: 認可・監査（30日以内） / Phase 3: Authorization & Audit (Within 30 Days)

**目標 / Goal**: 細粒度アクセス制御と監査証跡 / Fine-grained access control and audit trail

| タスク / Task | 担当 / Owner | 完了基準 / Done Criteria |
|--------|------|---------|
| JWT認証サポート / JWT auth support | Security | 署名検証、クレーム抽出 / Signature verification, claims extraction |
| RBAC実装 / RBAC implementation | Security | ツール別権限マトリクス / Per-tool permission matrix |
| 監査ログ強化 / Enhance audit logs | Security | 構造化ログ出力 / Structured log output |
| 監査ログDB保存 / Audit log DB storage | Database | tool_invocationsテーブル拡張 / tool_invocations table extension |

### Phase 4: MCP仕様準拠（将来） / Phase 4: MCP Spec Compliance (Future)

**目標 / Goal**: OAuth 2.1完全対応 / Full OAuth 2.1 compliance

| タスク / Task | 担当 / Owner | 完了基準 / Done Criteria |
|--------|------|---------|
| HTTPトランスポート追加 / Add HTTP transport | Backend | SSE対応 / SSE support |
| OAuth 2.1実装 / OAuth 2.1 implementation | Security | PKCE必須 / PKCE required |
| RFC 9728対応 / RFC 9728 compliance | Security | Protected Resource Metadata |

---

## 8. テスト要件 / Test Requirements

### 8.1 セキュリティテスト / Security Tests

```typescript
// __tests__/security/auth.test.ts
describe('認証ミドルウェア', () => {
  it('APIキーなしでリクエストを拒否', async () => {
    const result = await handleToolCall('layout.search', {}, { isAuthenticated: false, roles: [] });
    expect(result).toMatchObject({ isError: true });
  });

  it('無効なAPIキーを拒否', async () => {
    // ...
  });

  it('有効なAPIキーで認証成功', async () => {
    // ...
  });
});

describe('レート制限', () => {
  it('制限超過時に429を返す', async () => {
    // ...
  });

  it('ウィンドウリセット後にリクエスト許可', async () => {
    // ...
  });
});

describe('RBAC', () => {
  it('viewerがlayout.ingestを実行できない', async () => {
    // ...
  });

  it('adminが全ツール実行可能', async () => {
    // ...
  });
});
```

### 8.2 カバレッジ目標 / Coverage Targets

| テスト種別 / Test Type | 目標カバレッジ / Target Coverage |
|-----------|--------------|
| 認証ロジック / Auth logic | 100% |
| レート制限 / Rate limiting | 90%以上 / 90%+ |
| RBAC | 100% |
| エラーハンドリング / Error handling | 90%以上 / 90%+ |

---

## 9. MCP固有の考慮事項 / MCP-Specific Considerations

### 9.1 StdIOトランスポートの認証 / StdIO Transport Authentication

StdIOトランスポートでは、HTTPヘッダーによる認証ができない。代替手段:

HTTP header-based authentication is not possible with StdIO transport. Alternative methods:

**オプション1 / Option 1**: 環境変数による認証 / Authentication via environment variables

<!-- NOTE: Phase 1実装では MCP_API_KEYS（複数形、カンマ区切り）に変更済み。以下は設計時の記載。 -->
```json
// .mcp.json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "env": {
        "MCP_API_KEY": "${REFTRIX_MCP_API_KEY}"
      }
    }
  }
}
```

**オプション2 / Option 2**: 初期化時の認証ハンドシェイク / Authentication handshake at initialization
```typescript
// 最初のツール呼び出しで認証 / Authenticate on first tool call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'auth.authenticate') {
    return handleAuthentication(request.params.arguments);
  }

  if (!sessionAuthenticated) {
    return { isError: true, content: [{ type: 'text', text: 'Not authenticated' }] };
  }

  // ... 通常のツール処理 / ... normal tool processing
});
```

### 9.2 Claude Desktopとの連携 / Integration with Claude Desktop

Claude Desktopは信頼されたクライアントとして扱われるが、以下を考慮:

Claude Desktop is treated as a trusted client, but the following should be considered:

1. **ユーザー識別 / User identification**: OSユーザー情報を取得して監査ログに記録 / Retrieve OS user info and record in audit logs
2. **セッション管理 / Session management**: Claude Desktopのセッションとの連携 / Integration with Claude Desktop sessions
3. **権限継承 / Permission inheritance**: Claude Desktopの認証情報をMCPサーバーに伝播 / Propagate Claude Desktop auth info to MCP server

### 9.3 開発環境と本番環境の分離 / Development vs Production Separation

| 項目 / Item | 開発環境 / Development | 本番環境 / Production |
|------|---------|---------|
| 認証 / Auth | APIキー（オプション） / API key (optional) | JWT必須 / JWT required |
| レート制限 / Rate limiting | 緩和 / Relaxed | 厳格 / Strict |
| ログレベル / Log level | DEBUG | INFO |
| 監査ログ / Audit logs | コンソール / Console | DB + 外部サービス / DB + external services |
| APIキーバイパス / API key bypass | 可能 / Possible | 不可 / Not allowed |

```typescript
// 環境別設定 / Environment-specific configuration
const authConfig = {
  development: {
    enabled: process.env.MCP_AUTH_ENABLED !== 'false',
    bypassAllowed: true,
    rateLimitMultiplier: 10,
  },
  production: {
    enabled: true,
    bypassAllowed: false,
    rateLimitMultiplier: 1,
  },
}[process.env.NODE_ENV || 'development'];
```

---

## 10. 参考資料 / References

### 10.1 外部リソース / External Resources

- [MCP Authorization Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [MCP Spec Updates from June 2025 - Auth0](https://auth0.com/blog/mcp-specs-update-all-about-auth/)
- [MCP Authentication and Authorization Guide - Stytch](https://stytch.com/blog/MCP-authentication-and-authorization-guide/)
- [CWE-306: Missing Authentication for Critical Function](https://cwe.mitre.org/data/definitions/306.html)
- [OWASP Top 10:2021 A07 Identification and Authentication Failures](https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/)
- [Diving Into the MCP Authorization Specification - Descope](https://www.descope.com/blog/post/mcp-auth-spec)

### 10.2 内部ドキュメント / Internal Documents

- ` - セキュリティ要件 / Security requirements
- `packages/security/` - セキュリティパッケージ / Security package

### 10.3 関連CVE/CWE / Related CVE/CWE

| 識別子 / Identifier | 説明 / Description | 関連性 / Relevance |
|--------|------|--------|
| CWE-306 | Missing Authentication for Critical Function | 直接該当 / Directly applicable |
| CWE-287 | Improper Authentication | 関連 / Related |
| CWE-862 | Missing Authorization | 認可欠如 / Missing authorization |
| CWE-307 | Improper Restriction of Excessive Authentication Attempts | レート制限 / Rate limiting |

---

## 11. 決定事項 / Decisions

### 11.1 採用決定 / Adopted Decisions

| 決定項目 / Decision Item | 採用内容 / Adopted | 理由 / Reason |
|---------|---------|------|
| Phase 1認証方式 / Phase 1 auth method | APIキー / API Key | 実装コスト最小、即座に対応可能 / Minimal impl. cost, immediately actionable |
| Phase 2認証方式 / Phase 2 auth method | JWT | 外部システムとの統合、細粒度制御 / External system integration, fine-grained control |
| レート制限 / Rate limiting | インメモリ / In-memory | Redis不要、単一プロセス十分 / No Redis needed, single process sufficient |
| RBAC | 3ロール / 3 roles | admin/editor/viewer |

### 11.2 却下事項 / Rejected Items

| 却下項目 / Rejected Item | 理由 / Reason |
|---------|------|
| OAuth 2.1即座導入 / Immediate OAuth 2.1 | 実装コストが高い、StdIO非対応 / High impl. cost, StdIO not supported |
| mTLS | 開発体験を損なう / Degrades developer experience |
| 外部認証サービス / External auth service | 依存関係増加 / Increased dependencies |

---

## 12. 署名 / Signatures

| 役割 / Role | 名前 / Name | 日付 / Date |
|------|------|------|
| セキュリティエンジニア / Security Engineer | Reftrix Security Team | 2026-03-01 |
| レビュー担当 / Reviewer | - | - |
| 承認者 / Approver | - | - |

---

**次のアクション / Next Action**: Phase 1実装の技術設計書作成 / Create Phase 1 implementation technical design document
