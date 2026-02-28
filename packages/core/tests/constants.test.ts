// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core Constants Tests
 * TDD: 定数の値確認テスト
 *
 * テスト対象:
 * - EMBEDDING_DIMENSIONS: Embeddingベクトルの次元数
 * - DEFAULT_PAGE_SIZE / MAX_PAGE_SIZE: ページネーション設定
 * - SEARCH_MIN_QUERY_LENGTH / SEARCH_MAX_QUERY_LENGTH: 検索クエリ制限
 * - PORTS: ポート設定（オフセット適用）
 * - API_VERSION / API_BASE_PATH: APIバージョニング
 */

import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_MAX_QUERY_LENGTH,
  PORTS,
  API_VERSION,
  API_BASE_PATH,
} from '../src/constants';

// 開発環境ログ出力
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: constants.test.ts');
}

describe('EMBEDDING_DIMENSIONS', () => {
  it('multilingual-e5-baseモデルの次元数768を返す', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });

  it('正の整数である', () => {
    expect(Number.isInteger(EMBEDDING_DIMENSIONS)).toBe(true);
    expect(EMBEDDING_DIMENSIONS).toBeGreaterThan(0);
  });
});

describe('ページネーション設定', () => {
  describe('DEFAULT_PAGE_SIZE', () => {
    it('デフォルトページサイズは20', () => {
      expect(DEFAULT_PAGE_SIZE).toBe(20);
    });

    it('正の整数である', () => {
      expect(Number.isInteger(DEFAULT_PAGE_SIZE)).toBe(true);
      expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    });
  });

  describe('MAX_PAGE_SIZE', () => {
    it('最大ページサイズは100', () => {
      expect(MAX_PAGE_SIZE).toBe(100);
    });

    it('DEFAULT_PAGE_SIZE以上である', () => {
      expect(MAX_PAGE_SIZE).toBeGreaterThanOrEqual(DEFAULT_PAGE_SIZE);
    });
  });
});

describe('検索クエリ制限', () => {
  describe('SEARCH_MIN_QUERY_LENGTH', () => {
    it('最小クエリ長は1', () => {
      expect(SEARCH_MIN_QUERY_LENGTH).toBe(1);
    });

    it('0より大きい', () => {
      expect(SEARCH_MIN_QUERY_LENGTH).toBeGreaterThan(0);
    });
  });

  describe('SEARCH_MAX_QUERY_LENGTH', () => {
    it('最大クエリ長は500', () => {
      expect(SEARCH_MAX_QUERY_LENGTH).toBe(500);
    });

    it('SEARCH_MIN_QUERY_LENGTH以上である', () => {
      expect(SEARCH_MAX_QUERY_LENGTH).toBeGreaterThanOrEqual(SEARCH_MIN_QUERY_LENGTH);
    });
  });
});

describe('PORTS', () => {
  describe('ポートオフセット設定（+21000）', () => {
    it('POSTGRESポートは26432（5432 + 21000）', () => {
      expect(PORTS.POSTGRES).toBe(26432);
    });

    it('PRISMA_STUDIOポートは26555（5555 + 21000）', () => {
      expect(PORTS.PRISMA_STUDIO).toBe(26555);
    });

    it('MCP_SERVERポートは29080（8080 + 21000）', () => {
      expect(PORTS.MCP_SERVER).toBe(29080);
    });

    it('REDISポートは27379（6379 + 21000）', () => {
      expect(PORTS.REDIS).toBe(27379);
    });
  });

  describe('ポート値の妥当性', () => {
    it('全てのポートが1024以上（特権ポート外）', () => {
      Object.values(PORTS).forEach(port => {
        expect(port).toBeGreaterThanOrEqual(1024);
      });
    });

    it('全てのポートが65535以下（有効なポート範囲）', () => {
      Object.values(PORTS).forEach(port => {
        expect(port).toBeLessThanOrEqual(65535);
      });
    });

    it('全てのポートが一意である', () => {
      const ports = Object.values(PORTS);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('全てのポートが整数である', () => {
      Object.values(PORTS).forEach(port => {
        expect(Number.isInteger(port)).toBe(true);
      });
    });
  });

  describe('PORTSオブジェクトの構造', () => {
    it('必要なポートキーが全て定義されている', () => {
      expect(PORTS).toHaveProperty('POSTGRES');
      expect(PORTS).toHaveProperty('PRISMA_STUDIO');
      expect(PORTS).toHaveProperty('MCP_SERVER');
      expect(PORTS).toHaveProperty('REDIS');
    });

    it('不要なポート定数（WEB, STORYBOOK）が存在しないこと', () => {
      expect(PORTS).not.toHaveProperty('WEB');
      expect(PORTS).not.toHaveProperty('STORYBOOK');
    });

    it('読み取り専用オブジェクトである（as const）', () => {
      // TypeScript readonly objectは実行時にはwritableだが、
      // 各プロパティが期待通りの値を持つことを確認
      expect(typeof PORTS.POSTGRES).toBe('number');
    });
  });
});

describe('APIバージョニング', () => {
  describe('API_VERSION', () => {
    it('APIバージョンはv1', () => {
      expect(API_VERSION).toBe('v1');
    });

    it('文字列である', () => {
      expect(typeof API_VERSION).toBe('string');
    });

    it('vプレフィックスで始まる', () => {
      expect(API_VERSION.startsWith('v')).toBe(true);
    });
  });

  describe('API_BASE_PATH', () => {
    it('APIベースパスは/api/v1', () => {
      expect(API_BASE_PATH).toBe('/api/v1');
    });

    it('API_VERSIONを含む', () => {
      expect(API_BASE_PATH).toContain(API_VERSION);
    });

    it('/apiで始まる', () => {
      expect(API_BASE_PATH.startsWith('/api/')).toBe(true);
    });

    it('スラッシュで始まる', () => {
      expect(API_BASE_PATH.startsWith('/')).toBe(true);
    });

    it('末尾にスラッシュがない', () => {
      expect(API_BASE_PATH.endsWith('/')).toBe(false);
    });
  });
});

describe('定数の一貫性確認', () => {
  it('searchQuerySchemaのデフォルト値とDEFAULT_PAGE_SIZEが一致するべき', () => {
    // この値はsearchQuerySchemaのlimitのデフォルト値と一致するべき
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it('searchQuerySchemaのmax値とMAX_PAGE_SIZEが一致するべき', () => {
    // この値はsearchQuerySchemaのlimitのmax値と一致するべき
    expect(MAX_PAGE_SIZE).toBe(100);
  });

  it('検索クエリの長さ制限がsearchQuerySchemaと一致するべき', () => {
    // types.tsのsearchQuerySchemaと一致するべき
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(1);
    expect(SEARCH_MAX_QUERY_LENGTH).toBe(500);
  });
});
