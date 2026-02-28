# Security Policy

[日本語版](#日本語版) | [English](#english-version)

---

## 日本語版

## セキュリティポリシー

Reftrixプロジェクトのセキュリティを真剣に受け止めています。このドキュメントでは、セキュリティ脆弱性の報告方法と、サポートされているバージョンについて説明します。

---

## サポートされているバージョン

現在、以下のバージョンがセキュリティアップデートの対象です:

| バージョン | サポート状況 |
|----------|------------|
| 0.1.x    | ✅ サポート中 |
| < 0.1.0  | ❌ サポート対象外 |

**注意**: Reftrixは初回リリース（v0.1.0）です。安定性が確認されるまで、本番環境での使用にはご注意ください。

---

## セキュリティ脆弱性の報告

セキュリティ脆弱性を発見した場合は、以下の方法で**責任ある開示**を行ってください。

### 報告方法

**公開のIssueトラッカーでは報告しないでください。**

セキュリティ脆弱性は、以下の方法で非公開に報告してください:

1. **GitHub Security Advisories**（推奨）

   - リポジトリの「Security」タブから「Report a vulnerability」をクリック
   - 脆弱性の詳細を記入
   - 「Submit report」をクリック

2. **メール報告**（代替手段）

   セキュリティ関連の問題は、以下のメールアドレスに報告してください:

   **security@reftrix.io**

   件名: `[SECURITY] 脆弱性報告: <簡潔な説明>`

### 報告内容に含めるべき情報

脆弱性を報告する際は、以下の情報を含めてください:

- **脆弱性の種類**: XSS、SQLインジェクション、CSRF、情報漏洩など
- **影響範囲**: どのコンポーネント/モジュールが影響を受けるか
- **再現手順**: 脆弱性を再現するための詳細な手順
- **影響**: 脆弱性が悪用された場合の潜在的な影響
- **提案する修正方法**（可能であれば）
- **CVE ID**（既に割り当てられている場合）

### 報告後の流れ

1. **受領確認**: 報告を受け取ってから**48時間以内**に確認メールを送信します
2. **初期評価**: **5営業日以内**に初期評価を行い、深刻度を判断します
3. **修正作業**: 深刻度に応じて修正作業を開始します

   | 深刻度 | 対応開始（Response） | 修正完了目標（Resolution Target） |
   |--------|---------------------|----------------------------------|
   | **Critical** | 24時間以内 | 7日以内 |
   | **High** | 48時間以内 | 30日以内 |
   | **Medium** | 7日以内 | 60日以内 |
   | **Low** | 90日以内 | 次リリース |

   > **注意**: 上記のタイムラインは最善努力目標であり、保証ではありません。プロジェクトの規模やリソースにより、対応が遅延する場合があります。商用サポートが必要な場合は、別途お問い合わせください。

4. **パッチリリース**: 修正が完了次第、パッチをリリースします
5. **公開**: 修正版リリース後、脆弱性情報を公開します

---

## 責任ある開示ポリシー

セキュリティ研究者の皆様には、以下のガイドラインに従って責任ある開示を行っていただくようお願いします:

### 行動規範

✅ **推奨される行動**:

- 脆弱性を非公開で報告する
- 修正版がリリースされるまで脆弱性情報を公開しない
- 脆弱性の影響を最小限にとどめるための情報を提供する
- プロジェクトチームと協力して問題を解決する

❌ **禁止される行動**:

- 脆弱性を公開のIssueやSNSで公開する
- 他のユーザーのデータにアクセスする
- サービスの可用性を損なう
- 脆弱性を悪用する

### セキュリティ研究者への謝辞

責任ある開示を行ったセキュリティ研究者の方々に対して、以下の形で謝辞を表します:

- **公式謝辞**: SECURITY.mdとリリースノートに名前を掲載（希望する場合）
- **CVE割り当て**: 必要に応じてCVE IDを申請

---

## セキュリティ対策

Reftrixプロジェクトでは、以下のセキュリティ対策を実施しています:

### 開発段階

- **依存関係スキャン**: pnpm auditによる定期的なスキャン
- **静的解析**: ESLint、TypeScriptによるコード品質チェック
- **SSRF対策**: プライベートIP・メタデータサービスへのアクセスをブロック
- **入力検証**: Zodによる厳格な入力検証
- **HTMLサニタイズ**: DOMPurify v3.3によるXSS対策
- **認証**: APIキー認証（実装済み、`MCP_AUTH_ENABLED=true` で有効化）
- **CSP**: Content Security Policyの適用（将来的な実装目標、現在未実装）
- **レート制限**: API Rate Limiting（将来的な実装目標、現在はエラーコード定義のみ）

> **Warning**: ネットワーク経由でMCPサーバーを公開する場合は必ず `MCP_AUTH_ENABLED=true` と `MCP_API_KEYS` を設定してください。

### CI/CD

- **自動テスト**: 全PRに対してテスト実行
- **セキュリティスキャン**: 依存関係の脆弱性チェック
- **コードレビュー**: 最低1人のレビュアーによる承認
- **品質ゲート**: セキュリティ脆弱性（High/Critical）0件を必須化

### インフラストラクチャ

- **バックアップ暗号化**: AES-256-GCMによるバックアップファイルの暗号化（encryption-service.ts）
- **データベース暗号化**: 保存データの暗号化は運用者のインフラ設定に依存（PostgreSQLのTDE、ディスク暗号化等）
- **通信暗号化**: HTTPS/TLS通信（運用者のインフラ設定に依存）
- **環境変数管理**: 機密情報の安全な管理
- **アクセス制御**: 最小権限の原則

---

## DOMPurify設定

Reftrixでは、Webページクロール時に取得したHTMLをDOMPurify v3.3.xでサニタイズしています。

### 設定概要

| 項目 | 設定値 | 目的 |
|------|--------|------|
| FORBID_TAGS | script, iframe, form, object, embed等 | XSS/フィッシング防止 |
| FORBID_ATTR | on*イベントハンドラ, formaction, xlink:href | イベントベースXSS防止 |
| ALLOW_UNKNOWN_PROTOCOLS | false | javascript:, vbscript:等のブロック |
| SAFE_FOR_TEMPLATES | true | テンプレートインジェクション防止 |
| SANITIZE_DOM | true | DOM Clobbering防止 |

### 大規模HTML処理時のバイパス（SEC-H1）

パフォーマンス上の制約により、以下の条件でDOMPurifyの実行がスキップされます:

1. **事前削減（Pre-strip）**: 500K文字以上のHTMLに対して、正規表現で危険タグを事前除去
2. **DOMPurifyバイパス**: 事前削減後も1M文字以上のHTMLに対して、DOMPurify（JSDOM）の実行をスキップ

**リスク評価**:
- バイパス時も、事前削減（`preStripDangerousTags`）により`<script>`, `<iframe>`, `<object>`等は除去済み
- HTMLはDB保存用途であり、ブラウザで直接レンダリングされない
- 属性ベースのXSS（`onerror`, `javascript:` URL等）はDB保存文脈では無害

**重要**: HTMLをブラウザで直接レンダリングする用途に変更する場合は、DOMPurifyバイパスを無効化する必要があります。

### WHOLE_DOCUMENTモード

`page.analyze`の品質評価パイプライン（aXeアクセシビリティ検証）では、`<html>`, `<head>`, `<body>`構造を保持するWHOLE_DOCUMENTモードを使用します。

- `<meta http-equiv>` はフックで除去（オープンリダイレクト/Cookieインジェクション防止）
- `<link>`, `<base>` は除去（外部リソース操作防止）
- `<title>`, `<meta name>`, `<meta charset>` は保持（WCAG 2.1 AA準拠のため）

### 設定ファイル

- 実装: `apps/mcp-server/src/utils/html-sanitizer.ts`
- テスト: `apps/mcp-server/tests/security/html-sanitizer.test.ts`
- 規約: [`.claude/rules/security.md`](.claude/rules/security.md)

---

## 既知の脆弱性と修正履歴

### v0.1.0以降

現在、公開されている脆弱性はありません。

---

## セキュリティアップデートの通知

セキュリティアップデートは以下の方法で通知されます:

- **GitHub Security Advisories**: リポジトリの「Security」タブ
- **リリースノート**: セキュリティ修正を含むリリースノート
- [CHANGELOG.md](./CHANGELOG.md): 詳細な変更履歴

---

## セキュリティベストプラクティス

### 開発者向け

- **依存関係の更新**: 定期的に依存関係を最新版に更新する
- **環境変数**: `.env`ファイルをgitにコミットしない
- **シークレット管理**: APIキーやパスワードをコードに埋め込まない
- **入力検証**: すべてのユーザー入力を検証する
- **エラーハンドリング**: 本番環境でスタックトレースを公開しない

### ユーザー向け

- **定期的な更新**: 最新のセキュリティパッチを適用する
- **環境変数の保護**: 機密情報を適切に管理する
- **HTTPS使用**: 本番環境では必ずHTTPSを使用する
- **アクセス制限**: データベースへのアクセスを制限する

---

## 参考資料

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE Top 25](https://cwe.mitre.org/top25/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [PostgreSQL Security](https://www.postgresql.org/docs/current/security.html)

---

## 連絡先

セキュリティに関する質問や懸念事項がある場合は、以下の方法でお問い合わせください:

- **GitHub Security Advisories**: リポジトリの「Security」タブ
- **メール**: security@reftrix.io

---

**最終更新日**: 2026-03-01

---

## English Version

## Security Policy

We take the security of the ReftrixMCP project seriously. This document outlines how to report security vulnerabilities and which versions are supported.

---

## Supported Versions

The following versions are currently receiving security updates:

| Version | Support Status |
|---------|---------------|
| 0.1.x   | ✅ Supported |
| < 0.1.0 | ❌ Not Supported |

**Note**: ReftrixMCP is an initial release (v0.1.0). Please exercise caution when using in production until stability is confirmed.

---

## Reporting a Vulnerability

If you discover a security vulnerability, please practice **responsible disclosure** using the following methods.

### How to Report

**Do NOT report security vulnerabilities through public issue trackers.**

Report security vulnerabilities privately using one of these methods:

1. **GitHub Security Advisories** (Recommended)

   - Navigate to the repository's "Security" tab
   - Click "Report a vulnerability"
   - Fill in the vulnerability details
   - Click "Submit report"

2. **Email Reporting** (Alternative)

   Send security-related issues to:

   **security@reftrix.io**

   Subject: `[SECURITY] Vulnerability Report: <brief description>`

### Information to Include

When reporting a vulnerability, please include:

- **Vulnerability type**: XSS, SQL Injection, CSRF, information disclosure, etc.
- **Impact scope**: Which components/modules are affected
- **Reproduction steps**: Detailed steps to reproduce the vulnerability
- **Impact**: Potential consequences if exploited
- **Suggested fix** (if available)
- **CVE ID** (if already assigned)

### Response Timeline

1. **Acknowledgment**: Confirmation email within **48 hours** of receipt
2. **Initial assessment**: Severity evaluation within **5 business days**
3. **Fix development**: Start based on severity

   | Severity | Response | Resolution Target |
   |----------|----------|-------------------|
   | **Critical** | Within 24 hours | Within 7 days |
   | **High** | Within 48 hours | Within 30 days |
   | **Medium** | Within 7 days | Within 60 days |
   | **Low** | Within 90 days | Next release |

   > **Note**: The above timelines are best-effort targets, not guarantees. Actual response times may vary depending on project scale and available resources. For commercial support with SLA guarantees, please contact us separately.

4. **Patch release**: Release patch once fix is complete
5. **Public disclosure**: Publish vulnerability information after patch release

---

## Responsible Disclosure Policy

We request security researchers to follow these guidelines:

### Code of Conduct

✅ **Recommended Actions**:

- Report vulnerabilities privately
- Do not disclose until patch is released
- Provide information to minimize impact
- Collaborate with project team

❌ **Prohibited Actions**:

- Publicly disclose via issues or social media
- Access other users' data
- Disrupt service availability
- Exploit vulnerabilities

### Security Researcher Recognition

We acknowledge responsible disclosure through:

- **Official acknowledgment**: Listed in SECURITY.md and release notes (if desired)
- **CVE assignment**: Applied when appropriate

---

## Security Measures

ReftrixMCP implements the following security measures:

### Development Phase

- **Dependency scanning**: Regular scans with pnpm audit
- **Static analysis**: ESLint, TypeScript code quality checks
- **SSRF protection**: Block access to private IPs and metadata services
- **Input validation**: Strict validation with Zod
- **HTML sanitization**: XSS protection with DOMPurify v3.3
- **Authentication**: API key authentication (Implemented, enable with `MCP_AUTH_ENABLED=true`)
- **CSP**: Content Security Policy (planned, not yet implemented)
- **Rate limiting**: API rate limiting (planned, only error code defined currently)

> **Warning**: When exposing the MCP server over a network, you MUST set `MCP_AUTH_ENABLED=true` and configure `MCP_API_KEYS`.

### CI/CD

- **Automated testing**: Tests run on all PRs
- **Security scanning**: Dependency vulnerability checks
- **Code review**: Minimum 1 reviewer approval
- **Quality gates**: Zero High/Critical vulnerabilities required

### Infrastructure

- **Backup encryption**: AES-256-GCM backup file encryption (encryption-service.ts)
- **Database encryption**: Data-at-rest encryption depends on operator's infrastructure (PostgreSQL TDE, disk encryption, etc.)
- **Communication encryption**: HTTPS/TLS (depends on operator's infrastructure)
- **Environment variable management**: Secure secret management
- **Access control**: Principle of least privilege

---

## DOMPurify Configuration

Reftrix sanitizes HTML content from web page crawling using DOMPurify v3.3.x.

### Configuration Overview

| Setting | Value | Purpose |
|---------|-------|---------|
| FORBID_TAGS | script, iframe, form, object, embed, etc. | XSS/phishing prevention |
| FORBID_ATTR | on* event handlers, formaction, xlink:href | Event-based XSS prevention |
| ALLOW_UNKNOWN_PROTOCOLS | false | Block javascript:, vbscript:, etc. |
| SAFE_FOR_TEMPLATES | true | Template injection prevention |
| SANITIZE_DOM | true | DOM Clobbering prevention |

### Large HTML Bypass (SEC-H1)

Due to performance constraints, DOMPurify execution is skipped under specific conditions:

1. **Pre-strip**: For HTML over 500K characters, dangerous tags are pre-removed via regex
2. **DOMPurify bypass**: For HTML still over 1M characters after pre-strip, DOMPurify (JSDOM) execution is skipped

**Risk Assessment**:
- Even when bypassed, pre-strip (`preStripDangerousTags`) removes `<script>`, `<iframe>`, `<object>`, etc.
- HTML is stored in database and is NOT rendered directly in a browser
- Attribute-based XSS (`onerror`, `javascript:` URLs) is harmless in DB storage context

**Important**: If HTML rendering in browser becomes a use case, the DOMPurify bypass MUST be disabled.

### WHOLE_DOCUMENT Mode

The `page.analyze` quality evaluation pipeline (aXe accessibility testing) uses WHOLE_DOCUMENT mode to preserve `<html>`, `<head>`, `<body>` structure.

- `<meta http-equiv>` removed via hook (open redirect/cookie injection prevention)
- `<link>`, `<base>` removed (external resource manipulation prevention)
- `<title>`, `<meta name>`, `<meta charset>` preserved (WCAG 2.1 AA compliance)

### Configuration Files

- Implementation: `apps/mcp-server/src/utils/html-sanitizer.ts`
- Tests: `apps/mcp-server/tests/security/html-sanitizer.test.ts`
- Standards: [`.claude/rules/security.md`](.claude/rules/security.md)

---

## Known Vulnerabilities and Fix History

### Since v0.1.0

No publicly disclosed vulnerabilities at this time.

---

## Security Update Notifications

Security updates are announced via:

- **GitHub Security Advisories**: Repository "Security" tab
- **Release Notes**: Security fixes in release notes
- [CHANGELOG.md](./CHANGELOG.md): Detailed change history

---

## Security Best Practices

### For Developers

- **Update dependencies**: Regularly update to latest versions
- **Environment variables**: Never commit `.env` files
- **Secret management**: Don't hardcode API keys or passwords
- **Input validation**: Validate all user input
- **Error handling**: Don't expose stack traces in production

### For Users

- **Regular updates**: Apply latest security patches
- **Protect environment variables**: Securely manage secrets
- **Use HTTPS**: Always use HTTPS in production
- **Access restrictions**: Limit database access

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE Top 25](https://cwe.mitre.org/top25/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [PostgreSQL Security](https://www.postgresql.org/docs/current/security.html)

---

## Contact

For security questions or concerns:

- **GitHub Security Advisories**: Repository "Security" tab
- **Email**: security@reftrix.io

---

**Last Updated**: 2026-03-01
