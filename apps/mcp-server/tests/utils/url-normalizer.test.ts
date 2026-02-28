// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL Normalizer Tests
 *
 * DB保存前のURL正規化ロジックを検証する。
 * 末尾スラッシュによる重複問題の防止が主目的。
 *
 * @module tests/utils/url-normalizer
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrlForStorage } from '../../src/utils/url-normalizer';

describe('normalizeUrlForStorage', () => {
  // ==========================================================
  // 末尾スラッシュ除去（メイン目的）
  // ==========================================================
  describe('trailing slash removal', () => {
    it('should strip trailing slash from root domain', () => {
      expect(normalizeUrlForStorage('https://example.com/')).toBe('https://example.com');
    });

    it('should strip trailing slash from path', () => {
      expect(normalizeUrlForStorage('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('should strip trailing slash from deep path', () => {
      expect(normalizeUrlForStorage('https://kokuyo.com/special/curiosity-is-life/')).toBe(
        'https://kokuyo.com/special/curiosity-is-life'
      );
    });

    it('should not change URL without trailing slash', () => {
      expect(normalizeUrlForStorage('https://example.com')).toBe('https://example.com');
    });

    it('should not change URL with path and no trailing slash', () => {
      expect(normalizeUrlForStorage('https://example.com/path')).toBe('https://example.com/path');
    });

    it('should normalize both trailing-slash variants to the same result', () => {
      const withSlash = normalizeUrlForStorage('https://cappen.com/');
      const withoutSlash = normalizeUrlForStorage('https://cappen.com');
      expect(withSlash).toBe(withoutSlash);
      expect(withSlash).toBe('https://cappen.com');
    });

    it('should normalize path trailing-slash variants to the same result', () => {
      const withSlash = normalizeUrlForStorage('https://kokuyo.com/special/curiosity-is-life/');
      const withoutSlash = normalizeUrlForStorage('https://kokuyo.com/special/curiosity-is-life');
      expect(withSlash).toBe(withoutSlash);
    });
  });

  // ==========================================================
  // ホスト名正規化
  // ==========================================================
  describe('hostname normalization', () => {
    it('should lowercase hostname', () => {
      expect(normalizeUrlForStorage('https://Example.COM')).toBe('https://example.com');
    });

    it('should lowercase hostname but preserve path case', () => {
      expect(normalizeUrlForStorage('https://Example.COM/Path')).toBe('https://example.com/Path');
    });
  });

  // ==========================================================
  // デフォルトポート除去
  // ==========================================================
  describe('default port removal', () => {
    it('should remove port 443 for https', () => {
      expect(normalizeUrlForStorage('https://example.com:443')).toBe('https://example.com');
    });

    it('should remove port 80 for http', () => {
      expect(normalizeUrlForStorage('http://example.com:80')).toBe('http://example.com');
    });

    it('should keep non-default port', () => {
      expect(normalizeUrlForStorage('https://example.com:8080')).toBe('https://example.com:8080');
    });
  });

  // ==========================================================
  // フラグメント除去
  // ==========================================================
  describe('fragment removal', () => {
    it('should remove hash fragment', () => {
      expect(normalizeUrlForStorage('https://example.com/page#section')).toBe(
        'https://example.com/page'
      );
    });

    it('should remove hash fragment from root', () => {
      expect(normalizeUrlForStorage('https://example.com/#top')).toBe('https://example.com');
    });
  });

  // ==========================================================
  // パス正規化
  // ==========================================================
  describe('path normalization', () => {
    it('should collapse multiple slashes in path', () => {
      expect(normalizeUrlForStorage('https://example.com//path///to////page')).toBe(
        'https://example.com/path/to/page'
      );
    });

    it('should handle multiple trailing slashes', () => {
      expect(normalizeUrlForStorage('https://example.com/path///')).toBe(
        'https://example.com/path'
      );
    });
  });

  // ==========================================================
  // クエリパラメータ正規化
  // ==========================================================
  describe('query parameter normalization', () => {
    it('should sort query parameters alphabetically', () => {
      expect(normalizeUrlForStorage('https://example.com?b=2&a=1')).toBe(
        'https://example.com?a=1&b=2'
      );
    });

    it('should keep query parameters when present', () => {
      expect(normalizeUrlForStorage('https://example.com/page?key=value')).toBe(
        'https://example.com/page?key=value'
      );
    });

    it('should strip trailing slash before query', () => {
      expect(normalizeUrlForStorage('https://example.com/path/?key=value')).toBe(
        'https://example.com/path?key=value'
      );
    });
  });

  // ==========================================================
  // 実際のデータセットからの重複ペアのテスト
  // ==========================================================
  describe('duplicate pair normalization (from production data)', () => {
    const duplicatePairs = [
      ['https://cappen.com', 'https://cappen.com/'],
      ['https://cosmos.network', 'https://cosmos.network/'],
      ['https://example.com', 'https://example.com/'],
      ['https://linear.app', 'https://linear.app/'],
      ['https://pitch.com', 'https://pitch.com/'],
      ['https://wise.com', 'https://wise.com/'],
      ['https://kokuyo.com/special/curiosity-is-life', 'https://kokuyo.com/special/curiosity-is-life/'],
    ];

    for (const [noSlash, withSlash] of duplicatePairs) {
      it(`should normalize ${noSlash} and ${withSlash} to the same URL`, () => {
        expect(normalizeUrlForStorage(noSlash!)).toBe(normalizeUrlForStorage(withSlash!));
      });
    }
  });

  // ==========================================================
  // エッジケース
  // ==========================================================
  describe('edge cases', () => {
    it('should handle whitespace trimming', () => {
      expect(normalizeUrlForStorage('  https://example.com  ')).toBe('https://example.com');
    });

    it('should handle invalid URL gracefully', () => {
      const result = normalizeUrlForStorage('not-a-url');
      expect(result).toBe('not-a-url');
    });

    it('should handle empty string', () => {
      const result = normalizeUrlForStorage('');
      expect(result).toBe('');
    });

    it('should handle URL with username and password', () => {
      // URL constructor parses user:pass@host, we just need it not to crash
      const result = normalizeUrlForStorage('https://user:pass@example.com/');
      expect(result).toBe('https://example.com');
    });

    it('should preserve path segments correctly', () => {
      expect(normalizeUrlForStorage('https://example.com/a/b/c')).toBe(
        'https://example.com/a/b/c'
      );
    });

    it('should be idempotent', () => {
      const url = 'https://example.com/path/';
      const first = normalizeUrlForStorage(url);
      const second = normalizeUrlForStorage(first);
      expect(first).toBe(second);
    });
  });
});
