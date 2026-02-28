// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL検証ユーティリティ テスト
 * SSRF対策のためのURL検証機能をテスト
 *
 * TDD Red Phase: テストを先に作成
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateExternalUrl,
  isBlockedHost,
  isBlockedIpRange,
  normalizeUrlForValidation,
  BLOCKED_HOSTS,
  BLOCKED_IP_RANGES,
  type UrlValidationResult,
} from '../../src/utils/url-validator';

describe('url-validator', () => {
  describe('validateExternalUrl', () => {
    describe('正常系テスト', () => {
      it('有効な外部URLを許可する', () => {
        const result = validateExternalUrl('https://example.com');
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('https:// プロトコルを許可する', () => {
        const result = validateExternalUrl('https://awwwards.com/site/example');
        expect(result.valid).toBe(true);
      });

      it('http:// プロトコルを許可する', () => {
        const result = validateExternalUrl('http://example.com');
        expect(result.valid).toBe(true);
      });

      it('ポート指定のあるURLを許可する', () => {
        const result = validateExternalUrl('https://example.com:8080/path');
        expect(result.valid).toBe(true);
      });

      it('パス付きURLを許可する', () => {
        const result = validateExternalUrl('https://example.com/path/to/page');
        expect(result.valid).toBe(true);
      });

      it('クエリパラメータ付きURLを許可する', () => {
        const result = validateExternalUrl('https://example.com?query=value');
        expect(result.valid).toBe(true);
      });

      it('ハッシュ付きURLを許可する', () => {
        const result = validateExternalUrl('https://example.com#section');
        expect(result.valid).toBe(true);
      });

      it('サブドメイン付きURLを許可する', () => {
        const result = validateExternalUrl('https://sub.example.com');
        expect(result.valid).toBe(true);
      });

      it('国際化ドメイン名を許可する', () => {
        const result = validateExternalUrl('https://例え.jp');
        expect(result.valid).toBe(true);
      });

      it('数字を含むドメインを許可する', () => {
        const result = validateExternalUrl('https://192.0.2.1:8080/api');
        // 192.0.2.0/24 は TEST-NET-1 (RFC5737) なので許可
        expect(result.valid).toBe(true);
      });
    });

    describe('SSRF対策: ブロックされるホスト', () => {
      it('localhost をブロックする', () => {
        const result = validateExternalUrl('https://localhost');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('localhost:3000 をブロックする', () => {
        const result = validateExternalUrl('https://localhost:3000');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('127.0.0.1 をブロックする', () => {
        const result = validateExternalUrl('https://127.0.0.1');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('127.0.0.1:8080 をブロックする', () => {
        const result = validateExternalUrl('https://127.0.0.1:8080');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('0.0.0.0 をブロックする', () => {
        const result = validateExternalUrl('https://0.0.0.0');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('AWS メタデータサービス (169.254.169.254) をブロックする', () => {
        const result = validateExternalUrl('http://169.254.169.254/latest/meta-data/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('GCP メタデータサービス (metadata.google.internal) をブロックする', () => {
        const result = validateExternalUrl('http://metadata.google.internal/computeMetadata/v1/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('[::1] (IPv6 localhost) をブロックする', () => {
        const result = validateExternalUrl('http://[::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('SSRF対策: ブロックされるIPレンジ', () => {
      it('10.0.0.0/8 (クラスAプライベート) をブロックする', () => {
        const testCases = [
          'http://10.0.0.1',
          'http://10.255.255.255',
          'http://10.1.2.3:8080/api',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('private');
        }
      });

      it('172.16.0.0/12 (クラスBプライベート) をブロックする', () => {
        const testCases = [
          'http://172.16.0.1',
          'http://172.31.255.255',
          'http://172.20.10.5:3000',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('private');
        }
      });

      it('172.15.0.0 はプライベートではないので許可する', () => {
        const result = validateExternalUrl('http://172.15.0.1');
        expect(result.valid).toBe(true);
      });

      it('172.32.0.0 はプライベートではないので許可する', () => {
        const result = validateExternalUrl('http://172.32.0.1');
        expect(result.valid).toBe(true);
      });

      it('192.168.0.0/16 (クラスCプライベート) をブロックする', () => {
        const testCases = [
          'http://192.168.0.1',
          'http://192.168.255.255',
          'http://192.168.1.100:80',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('private');
        }
      });

      it('127.0.0.0/8 (ループバック) をブロックする', () => {
        const testCases = [
          'http://127.0.0.1',
          'http://127.255.255.255',
          'http://127.0.0.2:8080',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('blocked');
        }
      });

      it('0.0.0.0/8 をブロックする', () => {
        const testCases = ['http://0.0.0.0', 'http://0.1.2.3'];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('blocked');
        }
      });

      it('169.254.0.0/16 (リンクローカル) をブロックする', () => {
        const testCases = [
          'http://169.254.0.1',
          'http://169.254.169.254',
          'http://169.254.255.255',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('blocked');
        }
      });
    });

    describe('無効なURL形式', () => {
      it('空文字列を拒否する', () => {
        const result = validateExternalUrl('');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('empty');
      });

      it('プロトコルなしを拒否する', () => {
        const result = validateExternalUrl('example.com');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('protocol');
      });

      it('無効なプロトコルを拒否する', () => {
        const testCases = [
          'ftp://example.com',
          'file:///etc/passwd',
          'javascript:alert(1)',
          'data:text/html,<script>alert(1)</script>',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toContain('protocol');
        }
      });

      it('不正な形式のURLを拒否する', () => {
        const testCases = [
          'https://',
          'https://.',
          'https://..',
          'https:// ',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          expect(result.valid).toBe(false);
        }
      });

      it('URLエンコードされたlocalhostを検出してブロックする', () => {
        const testCases = [
          'https://localhost%00.example.com',
          'https://127.0.0.1%00@example.com',
        ];

        for (const url of testCases) {
          const result = validateExternalUrl(url);
          // 不正な形式としてブロック
          expect(result.valid).toBe(false);
        }
      });
    });

    describe('エッジケース', () => {
      it('大文字のホスト名を正しく処理する', () => {
        const result = validateExternalUrl('https://LOCALHOST');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('空白を含むURLを拒否する', () => {
        const result = validateExternalUrl('https://example .com');
        expect(result.valid).toBe(false);
      });

      it('非常に長いURLを処理する', () => {
        const longPath = 'a'.repeat(10000);
        const result = validateExternalUrl(`https://example.com/${longPath}`);
        // 長いURLでもvalidかどうかは実装依存だが、エラーにならないこと
        expect(typeof result.valid).toBe('boolean');
      });

      it('ユニコードホストを処理する', () => {
        const result = validateExternalUrl('https://xn--n3h.com'); // Punycode
        expect(result.valid).toBe(true);
      });

      it('IPv6形式を処理する', () => {
        // パブリックIPv6
        const result = validateExternalUrl('http://[2001:db8::1]/');
        // 2001:db8::/32 は documentation 用なので許可
        expect(result.valid).toBe(true);
      });

      it('@ を含むURLを処理する（ユーザー情報部分）', () => {
        // user:pass@host 形式
        const result = validateExternalUrl('https://user:pass@example.com');
        expect(result.valid).toBe(true);
      });

      it('DNS rebinding攻撃対策: 数字のみのホスト名を検証する', () => {
        // IPアドレス形式かどうかを正しく判定
        const result = validateExternalUrl('http://192.168.1.1');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('private');
      });
    });
  });

  describe('isBlockedHost', () => {
    it('ブロックリストのホストを検出する', () => {
      expect(isBlockedHost('localhost')).toBe(true);
      expect(isBlockedHost('127.0.0.1')).toBe(true);
      expect(isBlockedHost('0.0.0.0')).toBe(true);
      expect(isBlockedHost('169.254.169.254')).toBe(true);
      expect(isBlockedHost('metadata.google.internal')).toBe(true);
    });

    it('許可されたホストを通過させる', () => {
      expect(isBlockedHost('example.com')).toBe(false);
      expect(isBlockedHost('awwwards.com')).toBe(false);
      expect(isBlockedHost('google.com')).toBe(false);
    });

    it('大文字小文字を区別しない', () => {
      expect(isBlockedHost('LOCALHOST')).toBe(true);
      expect(isBlockedHost('LocalHost')).toBe(true);
      expect(isBlockedHost('Metadata.Google.Internal')).toBe(true);
    });
  });

  describe('isBlockedIpRange', () => {
    it('プライベートIPレンジを検出する', () => {
      // 10.0.0.0/8
      expect(isBlockedIpRange('10.0.0.1')).toBe(true);
      expect(isBlockedIpRange('10.255.255.255')).toBe(true);

      // 172.16.0.0/12
      expect(isBlockedIpRange('172.16.0.1')).toBe(true);
      expect(isBlockedIpRange('172.31.255.255')).toBe(true);

      // 192.168.0.0/16
      expect(isBlockedIpRange('192.168.0.1')).toBe(true);
      expect(isBlockedIpRange('192.168.255.255')).toBe(true);

      // 127.0.0.0/8
      expect(isBlockedIpRange('127.0.0.1')).toBe(true);
      expect(isBlockedIpRange('127.255.255.255')).toBe(true);

      // 0.0.0.0/8
      expect(isBlockedIpRange('0.0.0.0')).toBe(true);
      expect(isBlockedIpRange('0.255.255.255')).toBe(true);

      // 169.254.0.0/16 (link-local)
      expect(isBlockedIpRange('169.254.0.1')).toBe(true);
      expect(isBlockedIpRange('169.254.255.255')).toBe(true);
    });

    it('パブリックIPを通過させる', () => {
      expect(isBlockedIpRange('8.8.8.8')).toBe(false);
      expect(isBlockedIpRange('1.1.1.1')).toBe(false);
      expect(isBlockedIpRange('203.0.113.1')).toBe(false);
      expect(isBlockedIpRange('172.15.0.1')).toBe(false); // 172.16未満
      expect(isBlockedIpRange('172.32.0.1')).toBe(false); // 172.32以上
    });

    it('非IPアドレスはfalseを返す', () => {
      expect(isBlockedIpRange('example.com')).toBe(false);
      expect(isBlockedIpRange('not-an-ip')).toBe(false);
    });
  });

  describe('normalizeUrlForValidation', () => {
    it('URLを正規化する', () => {
      expect(normalizeUrlForValidation('HTTPS://EXAMPLE.COM')).toBe('https://example.com');
    });

    it('末尾のスラッシュを処理する', () => {
      const result = normalizeUrlForValidation('https://example.com/');
      expect(result).toMatch(/^https:\/\/example\.com\/?$/);
    });

    it('空白をトリムする', () => {
      expect(normalizeUrlForValidation('  https://example.com  ')).toBe('https://example.com');
    });

    it('無効なURLでエラーを投げない', () => {
      expect(() => normalizeUrlForValidation('not-a-url')).not.toThrow();
    });

    // =============================================
    // P2-1: URL正規化ロジック強化 (TDD Red Phase)
    // 重複URL防止のための追加正規化ルール
    // =============================================
    describe('デフォルトポート除去', () => {
      it('https:// のデフォルトポート 443 を除去する', () => {
        expect(normalizeUrlForValidation('https://example.com:443')).toBe('https://example.com');
        expect(normalizeUrlForValidation('https://example.com:443/path')).toBe('https://example.com/path');
      });

      it('http:// のデフォルトポート 80 を除去する', () => {
        expect(normalizeUrlForValidation('http://example.com:80')).toBe('http://example.com');
        expect(normalizeUrlForValidation('http://example.com:80/path')).toBe('http://example.com/path');
      });

      it('非デフォルトポートは保持する', () => {
        expect(normalizeUrlForValidation('https://example.com:8443')).toBe('https://example.com:8443');
        expect(normalizeUrlForValidation('http://example.com:8080')).toBe('http://example.com:8080');
      });
    });

    describe('クエリパラメータのソート', () => {
      it('クエリパラメータをアルファベット順にソートする', () => {
        expect(normalizeUrlForValidation('https://example.com?b=2&a=1')).toBe('https://example.com?a=1&b=2');
        expect(normalizeUrlForValidation('https://example.com?z=3&m=2&a=1')).toBe('https://example.com?a=1&m=2&z=3');
      });

      it('同じキーの複数値を保持する', () => {
        const result = normalizeUrlForValidation('https://example.com?tag=b&tag=a');
        // 同じキーの場合は値もソートする
        expect(result).toBe('https://example.com?tag=a&tag=b');
      });

      it('空のクエリパラメータを除去する', () => {
        expect(normalizeUrlForValidation('https://example.com?')).toBe('https://example.com');
      });

      it('クエリパラメータの値をデコードしない（元の形式を維持）', () => {
        expect(normalizeUrlForValidation('https://example.com?q=%E3%83%86%E3%82%B9%E3%83%88')).toBe('https://example.com?q=%E3%83%86%E3%82%B9%E3%83%88');
      });
    });

    describe('フラグメント除去', () => {
      it('URLフラグメント（#hash）を除去する', () => {
        expect(normalizeUrlForValidation('https://example.com#section')).toBe('https://example.com');
        expect(normalizeUrlForValidation('https://example.com/path#section')).toBe('https://example.com/path');
        expect(normalizeUrlForValidation('https://example.com/path?q=1#section')).toBe('https://example.com/path?q=1');
      });
    });

    describe('パス正規化', () => {
      it('空パスを / に正規化しない（末尾スラッシュ除去優先）', () => {
        expect(normalizeUrlForValidation('https://example.com')).toBe('https://example.com');
      });

      it('パス内の連続スラッシュを単一スラッシュに正規化する', () => {
        expect(normalizeUrlForValidation('https://example.com//path//to//page')).toBe('https://example.com/path/to/page');
      });

      it('パス内の ./ を除去する', () => {
        expect(normalizeUrlForValidation('https://example.com/./path/./to')).toBe('https://example.com/path/to');
      });

      it('パス内の ../ を解決する', () => {
        expect(normalizeUrlForValidation('https://example.com/a/b/../c')).toBe('https://example.com/a/c');
      });
    });

    describe('重複検出用の統合テスト', () => {
      it('同一URLの異なる表記を同じ正規化結果にする', () => {
        const variations = [
          'https://example.com',
          'https://example.com/',
          'https://example.com:443',
          'https://example.com:443/',
          'HTTPS://EXAMPLE.COM',
          'https://EXAMPLE.COM:443/',
        ];
        const normalized = variations.map(normalizeUrlForValidation);
        const unique = [...new Set(normalized)];
        expect(unique.length).toBe(1);
        expect(unique[0]).toBe('https://example.com');
      });

      it('クエリパラメータの順序が異なるURLを同じ正規化結果にする', () => {
        const variations = [
          'https://example.com/search?q=test&page=1',
          'https://example.com/search?page=1&q=test',
        ];
        const normalized = variations.map(normalizeUrlForValidation);
        const unique = [...new Set(normalized)];
        expect(unique.length).toBe(1);
      });

      it('フラグメントの有無に関わらず同じ正規化結果にする', () => {
        const variations = [
          'https://example.com/page',
          'https://example.com/page#section1',
          'https://example.com/page#section2',
        ];
        const normalized = variations.map(normalizeUrlForValidation);
        const unique = [...new Set(normalized)];
        expect(unique.length).toBe(1);
        expect(unique[0]).toBe('https://example.com/page');
      });
    });
  });

  describe('定数エクスポート', () => {
    it('BLOCKED_HOSTSが正しくエクスポートされている', () => {
      expect(Array.isArray(BLOCKED_HOSTS)).toBe(true);
      expect(BLOCKED_HOSTS).toContain('localhost');
      expect(BLOCKED_HOSTS).toContain('127.0.0.1');
      expect(BLOCKED_HOSTS).toContain('169.254.169.254');
      expect(BLOCKED_HOSTS).toContain('metadata.google.internal');
    });

    it('BLOCKED_IP_RANGESが正しくエクスポートされている', () => {
      expect(Array.isArray(BLOCKED_IP_RANGES)).toBe(true);
      expect(BLOCKED_IP_RANGES.length).toBeGreaterThan(0);
      // RegExpの配列であることを確認
      expect(BLOCKED_IP_RANGES.every((r) => r instanceof RegExp)).toBe(true);
    });
  });

  // =============================================
  // IPv6 SSRF対策テスト (TDD Red Phase)
  // SEC監査指摘対応: IPv6プライベートアドレスのブロック
  // =============================================
  describe('SSRF対策: IPv6ブロック', () => {
    describe('IPv6ループバック', () => {
      it('::1 (IPv6ループバック) をブロックする', () => {
        // 角括弧付きのIPv6 URL形式
        const result = validateExternalUrl('http://[::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::1 をポート付きでブロックする', () => {
        const result = validateExternalUrl('http://[::1]:8080/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('0:0:0:0:0:0:0:1 (完全形式のIPv6ループバック) をブロックする', () => {
        const result = validateExternalUrl('http://[0:0:0:0:0:0:0:1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('IPv6リンクローカル (fe80::/10)', () => {
      it('fe80::1 をブロックする', () => {
        const result = validateExternalUrl('http://[fe80::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('fe80::1234:5678:abcd:ef01 をブロックする', () => {
        const result = validateExternalUrl('http://[fe80::1234:5678:abcd:ef01]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('febf::1 (fe80::/10の上限境界) をブロックする', () => {
        // febf は fe80::/10 の範囲内 (fe80-febf)
        const result = validateExternalUrl('http://[febf::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('fec0::1 (fe80::/10の範囲外) は許可する', () => {
        // fec0 は fe80::/10 の範囲外
        // 注: fec0::/10 は旧site-localで非推奨だが、テスト目的で範囲外確認
        const result = validateExternalUrl('http://[fec0::1]/');
        // 範囲外なので valid になるべき（他のブロックルールに該当しない限り）
        expect(result.valid).toBe(true);
      });
    });

    describe('IPv6ユニークローカルアドレス (fc00::/7 - ULA)', () => {
      it('fc00::1 をブロックする', () => {
        const result = validateExternalUrl('http://[fc00::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('fd00::1 をブロックする', () => {
        const result = validateExternalUrl('http://[fd00::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff をブロックする', () => {
        const result = validateExternalUrl(
          'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/'
        );
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('fd12:3456:789a::1 (典型的なULAアドレス) をブロックする', () => {
        const result = validateExternalUrl('http://[fd12:3456:789a::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('IPv4マップドIPv6 (::ffff:x.x.x.x)', () => {
      it('::ffff:127.0.0.1 (マップドループバック) をブロックする', () => {
        const result = validateExternalUrl('http://[::ffff:127.0.0.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::ffff:192.168.1.1 (マップドプライベート) をブロックする', () => {
        const result = validateExternalUrl('http://[::ffff:192.168.1.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::ffff:10.0.0.1 (マップドクラスAプライベート) をブロックする', () => {
        const result = validateExternalUrl('http://[::ffff:10.0.0.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::ffff:172.16.0.1 (マップドクラスBプライベート) をブロックする', () => {
        const result = validateExternalUrl('http://[::ffff:172.16.0.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::ffff:169.254.169.254 (マップドメタデータサービス) をブロックする', () => {
        const result = validateExternalUrl('http://[::ffff:169.254.169.254]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::ffff:8.8.8.8 (マップドパブリックIP) は許可する', () => {
        const result = validateExternalUrl('http://[::ffff:8.8.8.8]/');
        expect(result.valid).toBe(true);
      });

      it('::ffff:7f00:1 (16進数形式のマップドループバック) をブロックする', () => {
        // ::ffff:7f00:0001 は 127.0.0.1 の16進数表現
        const result = validateExternalUrl('http://[::ffff:7f00:1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('IPv4互換IPv6 (deprecated: ::x.x.x.x)', () => {
      it('::127.0.0.1 (互換ループバック) をブロックする', () => {
        const result = validateExternalUrl('http://[::127.0.0.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::192.168.1.1 (互換プライベート) をブロックする', () => {
        const result = validateExternalUrl('http://[::192.168.1.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::10.0.0.1 (互換クラスAプライベート) をブロックする', () => {
        const result = validateExternalUrl('http://[::10.0.0.1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::169.254.169.254 (互換メタデータサービス) をブロックする', () => {
        const result = validateExternalUrl('http://[::169.254.169.254]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('Teredo Tunneling (2001:0::/32)', () => {
      it('2001:0::1 をブロックする', () => {
        const result = validateExternalUrl('http://[2001:0::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('2001:0000:4136:e378:8000:63bf:3fff:fdd2 をブロックする', () => {
        // 典型的なTeredo アドレス
        const result = validateExternalUrl(
          'http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/'
        );
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('2001:1::1 (Teredo範囲外) は許可する', () => {
        // 2001:1::/32 は 2001:0::/32 の範囲外
        const result = validateExternalUrl('http://[2001:1::1]/');
        // IANA割り当て済みだが、Teredo範囲外なので許可されるべき
        expect(result.valid).toBe(true);
      });
    });

    describe('6to4 (2002::/16)', () => {
      it('2002::1 をブロックする', () => {
        const result = validateExternalUrl('http://[2002::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('2002:c0a8:101::1 (192.168.1.1のマッピング) をブロックする', () => {
        // 2002:c0a8:0101 = 2002:192.168.1.1 (プライベートIPの6to4)
        const result = validateExternalUrl('http://[2002:c0a8:101::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('2002:0a00:0001::1 (10.0.0.1のマッピング) をブロックする', () => {
        // 2002:0a00:0001 = 10.0.0.1 の6to4
        const result = validateExternalUrl('http://[2002:0a00:0001::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('2002:7f00:0001::1 (127.0.0.1のマッピング) をブロックする', () => {
        // 2002:7f00:0001 = 127.0.0.1 の6to4
        const result = validateExternalUrl('http://[2002:7f00:0001::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('その他のIPv6特殊アドレス', () => {
      it(':: (未指定アドレス) をブロックする', () => {
        const result = validateExternalUrl('http://[::]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('::0 (未指定アドレスのバリエーション) をブロックする', () => {
        const result = validateExternalUrl('http://[::0]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('0::0 (未指定アドレスのバリエーション) をブロックする', () => {
        const result = validateExternalUrl('http://[0::0]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('ff02::1 (リンクローカルマルチキャスト) をブロックする', () => {
        // マルチキャストアドレスは外部アクセス用途ではない
        const result = validateExternalUrl('http://[ff02::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });

      it('ff05::1 (サイトローカルマルチキャスト) をブロックする', () => {
        const result = validateExternalUrl('http://[ff05::1]/');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('blocked');
      });
    });

    describe('パブリックIPv6アドレス', () => {
      it('2001:db8::1 (ドキュメント用) を許可する', () => {
        // 2001:db8::/32 はドキュメント用だが、ブロック対象ではない
        const result = validateExternalUrl('http://[2001:db8::1]/');
        expect(result.valid).toBe(true);
      });

      it('2606:4700:4700::1111 (Cloudflare DNS) を許可する', () => {
        const result = validateExternalUrl('http://[2606:4700:4700::1111]/');
        expect(result.valid).toBe(true);
      });

      it('2001:4860:4860::8888 (Google DNS) を許可する', () => {
        const result = validateExternalUrl('http://[2001:4860:4860::8888]/');
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('isBlockedIpRange - IPv6対応', () => {
    describe('IPv6ループバック', () => {
      it('::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::1')).toBe(true);
      });

      it('0:0:0:0:0:0:0:1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('0:0:0:0:0:0:0:1')).toBe(true);
      });
    });

    describe('IPv6リンクローカル (fe80::/10)', () => {
      it('fe80::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('fe80::1')).toBe(true);
      });

      it('fe80::1234:5678:abcd:ef01 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('fe80::1234:5678:abcd:ef01')).toBe(true);
      });

      it('febf::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('febf::1')).toBe(true);
      });
    });

    describe('IPv6ユニークローカル (fc00::/7)', () => {
      it('fc00::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('fc00::1')).toBe(true);
      });

      it('fd00::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('fd00::1')).toBe(true);
      });

      it('fdff::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('fdff::1')).toBe(true);
      });
    });

    describe('IPv4マップドIPv6', () => {
      it('::ffff:127.0.0.1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::ffff:127.0.0.1')).toBe(true);
      });

      it('::ffff:192.168.1.1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::ffff:192.168.1.1')).toBe(true);
      });

      it('::ffff:10.0.0.1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::ffff:10.0.0.1')).toBe(true);
      });

      it('::ffff:8.8.8.8 は許可する', () => {
        expect(isBlockedIpRange('::ffff:8.8.8.8')).toBe(false);
      });
    });

    describe('IPv4互換IPv6', () => {
      it('::127.0.0.1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::127.0.0.1')).toBe(true);
      });

      it('::192.168.1.1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::192.168.1.1')).toBe(true);
      });
    });

    describe('Teredo (2001:0::/32)', () => {
      it('2001:0::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('2001:0::1')).toBe(true);
      });

      it('2001:0000:4136:e378::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('2001:0000:4136:e378::1')).toBe(true);
      });
    });

    describe('6to4 (2002::/16)', () => {
      it('2002::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('2002::1')).toBe(true);
      });

      it('2002:c0a8:101::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('2002:c0a8:101::1')).toBe(true);
      });
    });

    describe('マルチキャスト (ff00::/8)', () => {
      it('ff02::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('ff02::1')).toBe(true);
      });

      it('ff05::1 をブロック対象として検出する', () => {
        expect(isBlockedIpRange('ff05::1')).toBe(true);
      });
    });

    describe('未指定アドレス', () => {
      it(':: をブロック対象として検出する', () => {
        expect(isBlockedIpRange('::')).toBe(true);
      });
    });

    describe('パブリックIPv6', () => {
      it('2001:db8::1 は許可する', () => {
        expect(isBlockedIpRange('2001:db8::1')).toBe(false);
      });

      it('2606:4700:4700::1111 は許可する', () => {
        expect(isBlockedIpRange('2606:4700:4700::1111')).toBe(false);
      });
    });
  });
});
