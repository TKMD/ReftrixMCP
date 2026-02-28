// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL既知ドメインリスト テスト（TDD Red Phase）
 *
 * Phase4-3: 既知WebGLドメインリスト拡張
 * - 構造化されたドメインエントリ（tier, category, libraries）
 * - ユーザー報告サイト（Linear, Vercel, Notion）を含める
 * - カテゴリ別・Tier別の検索機能
 *
 * @module tests/tools/page/handlers/webgl-domains.test
 */

import { describe, it, expect } from 'vitest';

import {
  type WebGLDomainEntry,
  KNOWN_WEBGL_DOMAINS,
  WEBGL_DOMAIN_MAP,
  getDomainsByCategory,
  getDomainsByTier,
  getDomainEntry,
  isDomainInList,
} from '../../../../src/tools/page/handlers/webgl-domains';

// ============================================================================
// WebGLDomainEntry インターフェース テスト
// ============================================================================

describe('WebGLDomainEntry インターフェース', () => {
  it('必須フィールドが定義されていること', () => {
    const entry: WebGLDomainEntry = {
      domain: 'example.com',
      tier: 'webgl',
      category: 'product',
    };

    expect(entry.domain).toBe('example.com');
    expect(entry.tier).toBe('webgl');
    expect(entry.category).toBe('product');
  });

  it('オプショナルフィールド（libraries）が定義可能であること', () => {
    const entry: WebGLDomainEntry = {
      domain: 'threejs.org',
      tier: 'ultra-heavy',
      category: 'experiment',
      libraries: ['three.js'],
    };

    expect(entry.libraries).toEqual(['three.js']);
  });

  it('オプショナルフィールド（notes）が定義可能であること', () => {
    const entry: WebGLDomainEntry = {
      domain: 'linear.app',
      tier: 'ultra-heavy',
      category: 'product',
      notes: 'ユーザー報告のタイムアウトサイト',
    };

    expect(entry.notes).toBe('ユーザー報告のタイムアウトサイト');
  });
});

// ============================================================================
// KNOWN_WEBGL_DOMAINS 配列 テスト
// ============================================================================

describe('KNOWN_WEBGL_DOMAINS 配列', () => {
  it('エクスポートされていること', () => {
    expect(KNOWN_WEBGL_DOMAINS).toBeDefined();
    expect(Array.isArray(KNOWN_WEBGL_DOMAINS)).toBe(true);
  });

  it('最低30個のドメインが登録されていること', () => {
    expect(KNOWN_WEBGL_DOMAINS.length).toBeGreaterThanOrEqual(30);
  });

  it('全エントリが正しい構造を持っていること', () => {
    for (const entry of KNOWN_WEBGL_DOMAINS) {
      expect(entry).toHaveProperty('domain');
      expect(entry).toHaveProperty('tier');
      expect(entry).toHaveProperty('category');
      expect(typeof entry.domain).toBe('string');
      expect(['webgl', 'heavy', 'ultra-heavy']).toContain(entry.tier);
      expect([
        'award_gallery',
        'agency',
        'product',
        'experiment',
        'portfolio',
      ]).toContain(entry.category);
    }
  });

  describe('ユーザー報告サイト（タイムアウト報告あり）', () => {
    it('linear.app が含まれていること', () => {
      const linearEntry = KNOWN_WEBGL_DOMAINS.find(
        (e) => e.domain === 'linear.app'
      );
      expect(linearEntry).toBeDefined();
      expect(linearEntry?.tier).toBe('ultra-heavy');
      expect(linearEntry?.category).toBe('product');
      expect(linearEntry?.notes).toContain('ユーザー報告');
    });

    it('vercel.com が含まれていること', () => {
      const vercelEntry = KNOWN_WEBGL_DOMAINS.find(
        (e) => e.domain === 'vercel.com'
      );
      expect(vercelEntry).toBeDefined();
      expect(vercelEntry?.tier).toBe('heavy');
      expect(vercelEntry?.category).toBe('product');
      expect(vercelEntry?.notes).toContain('ユーザー報告');
    });

    it('notion.so が含まれていること', () => {
      const notionEntry = KNOWN_WEBGL_DOMAINS.find(
        (e) => e.domain === 'notion.so'
      );
      expect(notionEntry).toBeDefined();
      expect(notionEntry?.tier).toBe('heavy');
      expect(notionEntry?.category).toBe('product');
      expect(notionEntry?.notes).toContain('ユーザー報告');
    });
  });

  describe('Award Gallery サイト', () => {
    it.each([
      'awwwards.com',
      'thefwa.com',
      'cssdesignawards.com',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.category).toBe('award_gallery');
    });
  });

  describe('有名デジタルエージェンシー', () => {
    it.each([
      'resn.co.nz',
      'active-theory.com',
      'hello-monday.com',
      'northkingdom.com',
      'unit9.com',
      'immersive-g.com',
      'wild.as',
      'dogstudio.co',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.category).toBe('agency');
    });
  });

  describe('SaaS/Tech プロダクト', () => {
    it.each([
      'linear.app',
      'vercel.com',
      'notion.so',
      'stripe.com',
      'github.com',
      'figma.com',
      'framer.com',
      'raycast.com',
      'arc.net',
      'loom.com',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.category).toBe('product');
    });
  });

  describe('3D/WebGL実験サイト', () => {
    it.each([
      'threejs.org',
      'bruno-simon.com',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.category).toBe('experiment');
    });
  });

  describe('ポートフォリオ/個人サイト', () => {
    it.each([
      'robinnoguier.com',
      'patrickheng.com',
      'lusion.co',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.category).toBe('portfolio');
    });
  });

  describe('日本のWebデザインエージェンシー', () => {
    it.each([
      'baigie.me',
      'fourdigit.jp',
      'goodpatch.com',
    ])('%s が含まれていること', (domain) => {
      const entry = KNOWN_WEBGL_DOMAINS.find((e) => e.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.notes).toContain('日本');
    });
  });
});

// ============================================================================
// WEBGL_DOMAIN_MAP テスト
// ============================================================================

describe('WEBGL_DOMAIN_MAP', () => {
  it('エクスポートされていること', () => {
    expect(WEBGL_DOMAIN_MAP).toBeDefined();
    expect(WEBGL_DOMAIN_MAP instanceof Map).toBe(true);
  });

  it('KNOWN_WEBGL_DOMAINSと同じ数のエントリがあること', () => {
    expect(WEBGL_DOMAIN_MAP.size).toBe(KNOWN_WEBGL_DOMAINS.length);
  });

  it('ドメイン名で検索できること', () => {
    const entry = WEBGL_DOMAIN_MAP.get('resn.co.nz');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe('ultra-heavy');
    expect(entry?.category).toBe('agency');
  });

  it('存在しないドメインはundefinedを返すこと', () => {
    const entry = WEBGL_DOMAIN_MAP.get('nonexistent-domain.com');
    expect(entry).toBeUndefined();
  });

  it('linear.app を検索できること', () => {
    const entry = WEBGL_DOMAIN_MAP.get('linear.app');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe('ultra-heavy');
    expect(entry?.libraries).toContain('three.js');
  });
});

// ============================================================================
// getDomainsByCategory 関数 テスト
// ============================================================================

describe('getDomainsByCategory', () => {
  it('award_gallery カテゴリのドメインを取得できること', () => {
    const domains = getDomainsByCategory('award_gallery');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.category === 'award_gallery')).toBe(true);
  });

  it('agency カテゴリのドメインを取得できること', () => {
    const domains = getDomainsByCategory('agency');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.category === 'agency')).toBe(true);
    expect(domains.map((d) => d.domain)).toContain('resn.co.nz');
  });

  it('product カテゴリのドメインを取得できること', () => {
    const domains = getDomainsByCategory('product');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.category === 'product')).toBe(true);
    expect(domains.map((d) => d.domain)).toContain('linear.app');
    expect(domains.map((d) => d.domain)).toContain('vercel.com');
    expect(domains.map((d) => d.domain)).toContain('notion.so');
  });

  it('experiment カテゴリのドメインを取得できること', () => {
    const domains = getDomainsByCategory('experiment');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.category === 'experiment')).toBe(true);
    expect(domains.map((d) => d.domain)).toContain('threejs.org');
  });

  it('portfolio カテゴリのドメインを取得できること', () => {
    const domains = getDomainsByCategory('portfolio');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.category === 'portfolio')).toBe(true);
  });
});

// ============================================================================
// getDomainsByTier 関数 テスト
// ============================================================================

describe('getDomainsByTier', () => {
  it('webgl Tierのドメインを取得できること', () => {
    const domains = getDomainsByTier('webgl');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.tier === 'webgl')).toBe(true);
  });

  it('heavy Tierのドメインを取得できること', () => {
    const domains = getDomainsByTier('heavy');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.tier === 'heavy')).toBe(true);
  });

  it('ultra-heavy Tierのドメインを取得できること', () => {
    const domains = getDomainsByTier('ultra-heavy');
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((d) => d.tier === 'ultra-heavy')).toBe(true);
    expect(domains.map((d) => d.domain)).toContain('resn.co.nz');
    expect(domains.map((d) => d.domain)).toContain('linear.app');
  });

  it('ultra-heavy ドメインに resn.co.nz, active-theory.com, linear.app が含まれること', () => {
    const domains = getDomainsByTier('ultra-heavy');
    const domainNames = domains.map((d) => d.domain);
    expect(domainNames).toContain('resn.co.nz');
    expect(domainNames).toContain('active-theory.com');
    expect(domainNames).toContain('linear.app');
  });
});

// ============================================================================
// getDomainEntry 関数 テスト
// ============================================================================

describe('getDomainEntry', () => {
  it('存在するドメインのエントリを取得できること', () => {
    const entry = getDomainEntry('resn.co.nz');
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe('resn.co.nz');
    expect(entry?.tier).toBe('ultra-heavy');
  });

  it('www. プレフィックス付きでも取得できること', () => {
    const entry = getDomainEntry('www.resn.co.nz');
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe('resn.co.nz');
  });

  it('大文字小文字を区別しないこと', () => {
    const entry = getDomainEntry('RESN.CO.NZ');
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe('resn.co.nz');
  });

  it('存在しないドメインはundefinedを返すこと', () => {
    const entry = getDomainEntry('nonexistent.com');
    expect(entry).toBeUndefined();
  });

  it('URLからドメインを抽出して取得できること', () => {
    const entry = getDomainEntry('https://linear.app/team/project');
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe('linear.app');
  });
});

// ============================================================================
// isDomainInList 関数 テスト
// ============================================================================

describe('isDomainInList', () => {
  it('リストに含まれるドメインはtrueを返す', () => {
    expect(isDomainInList('resn.co.nz')).toBe(true);
    expect(isDomainInList('linear.app')).toBe(true);
    expect(isDomainInList('threejs.org')).toBe(true);
  });

  it('リストに含まれないドメインはfalseを返す', () => {
    expect(isDomainInList('google.com')).toBe(false);
    expect(isDomainInList('wikipedia.org')).toBe(false);
    expect(isDomainInList('nonexistent.com')).toBe(false);
  });

  it('www. プレフィックス付きでも正しく判定する', () => {
    expect(isDomainInList('www.resn.co.nz')).toBe(true);
    expect(isDomainInList('www.google.com')).toBe(false);
  });

  it('URLからドメインを抽出して判定する', () => {
    expect(isDomainInList('https://linear.app/team')).toBe(true);
    expect(isDomainInList('https://www.google.com/search')).toBe(false);
  });
});

// ============================================================================
// Tier 分類の一貫性 テスト
// ============================================================================

describe('Tier 分類の一貫性', () => {
  it('ultra-heavy ドメインの数が適切であること（5-15個程度）', () => {
    const ultraHeavy = getDomainsByTier('ultra-heavy');
    expect(ultraHeavy.length).toBeGreaterThanOrEqual(5);
    expect(ultraHeavy.length).toBeLessThanOrEqual(20);
  });

  it('heavy ドメインの数が適切であること（10-30個程度）', () => {
    const heavy = getDomainsByTier('heavy');
    expect(heavy.length).toBeGreaterThanOrEqual(10);
    expect(heavy.length).toBeLessThanOrEqual(40);
  });

  it('webgl ドメインが存在すること', () => {
    const webgl = getDomainsByTier('webgl');
    expect(webgl.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// カテゴリ分類の一貫性 テスト
// ============================================================================

describe('カテゴリ分類の一貫性', () => {
  it('全カテゴリの合計がKNOWN_WEBGL_DOMAINSと一致すること', () => {
    const categories: Array<WebGLDomainEntry['category']> = [
      'award_gallery',
      'agency',
      'product',
      'experiment',
      'portfolio',
    ];

    let total = 0;
    for (const category of categories) {
      total += getDomainsByCategory(category).length;
    }

    expect(total).toBe(KNOWN_WEBGL_DOMAINS.length);
  });

  it('全Tierの合計がKNOWN_WEBGL_DOMAINSと一致すること', () => {
    const tiers: Array<WebGLDomainEntry['tier']> = [
      'webgl',
      'heavy',
      'ultra-heavy',
    ];

    let total = 0;
    for (const tier of tiers) {
      total += getDomainsByTier(tier).length;
    }

    expect(total).toBe(KNOWN_WEBGL_DOMAINS.length);
  });
});

// ============================================================================
// パフォーマンス テスト
// ============================================================================

describe('パフォーマンス', () => {
  it('1000回のMap検索が10ms以内で完了すること', () => {
    const domains = [
      'resn.co.nz',
      'linear.app',
      'threejs.org',
      'google.com',
      'github.com',
    ];

    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      const domain = domains[i % domains.length];
      WEBGL_DOMAIN_MAP.get(domain);
    }

    const duration = performance.now() - startTime;
    expect(duration).toBeLessThan(10);
  });

  it('1000回のgetDomainEntry呼び出しが50ms以内で完了すること', () => {
    const inputs = [
      'resn.co.nz',
      'https://linear.app/team',
      'www.threejs.org',
      'google.com',
    ];

    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      const input = inputs[i % inputs.length];
      getDomainEntry(input);
    }

    const duration = performance.now() - startTime;
    expect(duration).toBeLessThan(50);
  });
});

// ============================================================================
// ライブラリ情報 テスト
// ============================================================================

describe('ライブラリ情報', () => {
  it('Three.js を使用していることが分かるドメインがあること', () => {
    const threeJsDomains = KNOWN_WEBGL_DOMAINS.filter(
      (d) => d.libraries?.includes('three.js')
    );
    expect(threeJsDomains.length).toBeGreaterThan(0);
    expect(threeJsDomains.map((d) => d.domain)).toContain('linear.app');
    expect(threeJsDomains.map((d) => d.domain)).toContain('resn.co.nz');
  });

  it('ライブラリ情報がない場合はundefinedまたは空配列であること', () => {
    for (const entry of KNOWN_WEBGL_DOMAINS) {
      if (entry.libraries !== undefined) {
        expect(Array.isArray(entry.libraries)).toBe(true);
      }
    }
  });
});

// ============================================================================
// 後方互換性 テスト（既存定数との整合性）
// ============================================================================

describe('後方互換性', () => {
  it('resn.co.nz が ultra-heavy として分類されていること（既存動作と一致）', () => {
    const entry = getDomainEntry('resn.co.nz');
    expect(entry?.tier).toBe('ultra-heavy');
  });

  it('activetheory.net/active-theory.com が ultra-heavy として分類されていること', () => {
    // active-theory.com で統一されている可能性を考慮
    const entryNet = getDomainEntry('activetheory.net');
    const entryCom = getDomainEntry('active-theory.com');

    // どちらかが存在すればOK
    const hasEntry = entryNet !== undefined || entryCom !== undefined;
    expect(hasEntry).toBe(true);

    if (entryNet) {
      expect(entryNet.tier).toBe('ultra-heavy');
    }
    if (entryCom) {
      expect(entryCom.tier).toBe('ultra-heavy');
    }
  });

  it('bruno-simon.com が heavy として分類されていること（既存動作と一致）', () => {
    const entry = getDomainEntry('bruno-simon.com');
    expect(entry?.tier).toBe('heavy');
  });

  it('threejs.org が heavy として分類されていること（既存動作と一致）', () => {
    const entry = getDomainEntry('threejs.org');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe('heavy');
  });
});
