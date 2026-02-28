// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL既知ドメインリスト
 *
 * Phase4-3: 既知WebGLドメインリスト拡張
 * - 構造化されたドメインエントリ（tier, category, libraries, notes）
 * - カテゴリ分類：award_gallery, agency, product, experiment, portfolio
 * - Tier分類：webgl, heavy, ultra-heavy
 * - ユーザー報告サイト（Linear, Vercel, Notion）を含む
 *
 * 目的：
 * - URL/ドメインベースの事前検出に使用
 * - 既知のWebGL/Three.js使用サイトを高速に識別
 * - 適切なタイムアウト・リトライ戦略を決定
 *
 * @module tools/page/handlers/webgl-domains
 */

import { type SiteTier } from './retry-strategy';

// ============================================================================
// 型定義
// ============================================================================

/**
 * WebGLドメインエントリ
 *
 * 既知のWebGL/Three.js使用サイトの情報を格納
 */
export interface WebGLDomainEntry {
  /** ドメイン名（www.なしの正規化形式） */
  domain: string;
  /** サイトの重さレベル（webgl < heavy < ultra-heavy） */
  tier: Exclude<SiteTier, 'normal'>;
  /** カテゴリ分類 */
  category: 'award_gallery' | 'agency' | 'product' | 'experiment' | 'portfolio';
  /** 使用している既知のライブラリ（オプション） */
  libraries?: string[];
  /** 補足情報（オプション） */
  notes?: string;
}

// ============================================================================
// 既知WebGLドメインリスト
// ============================================================================

/**
 * 既知のWebGL/Three.js使用サイトドメインリスト
 *
 * カテゴリ:
 * - award_gallery: アワードサイト（ユーザーが分析対象にする可能性が高い）
 * - agency: デジタルエージェンシー
 * - product: SaaS/Techプロダクト
 * - experiment: 3D/WebGL実験サイト
 * - portfolio: ポートフォリオ/個人サイト
 *
 * Tier:
 * - webgl: 軽めのWebGL使用（90秒タイムアウト）
 * - heavy: 重いWebGL使用（120秒タイムアウト）
 * - ultra-heavy: 非常に重い（180秒タイムアウト、リトライ制限）
 */
export const KNOWN_WEBGL_DOMAINS: readonly WebGLDomainEntry[] = [
  // =========================================================================
  // Award Galleries（アワードサイト）
  // ユーザーが分析対象にする可能性が高いサイト
  // =========================================================================
  {
    domain: 'awwwards.com',
    tier: 'heavy',
    category: 'award_gallery',
    notes: 'WebGL showcases',
  },
  {
    domain: 'thefwa.com',
    tier: 'heavy',
    category: 'award_gallery',
  },
  {
    domain: 'cssdesignawards.com',
    tier: 'webgl',
    category: 'award_gallery',
  },

  // =========================================================================
  // 有名デジタルエージェンシー
  // 高品質なWebGL/3Dエクスペリエンスを提供
  // =========================================================================
  {
    domain: 'resn.co.nz',
    tier: 'ultra-heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'active-theory.com',
    tier: 'ultra-heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'activetheory.net',
    tier: 'ultra-heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'activetheory.com',
    tier: 'ultra-heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'hello-monday.com',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'northkingdom.com',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'unit9.com',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'immersive-g.com',
    tier: 'ultra-heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'wild.as',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'dogstudio.co',
    tier: 'heavy',
    category: 'agency',
    libraries: ['three.js'],
  },
  {
    domain: 'basicagency.com',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'fantasy.co',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'cuberto.com',
    tier: 'heavy',
    category: 'agency',
  },
  {
    domain: 'unseen.co',
    tier: 'heavy',
    category: 'agency',
  },

  // =========================================================================
  // SaaS/Tech プロダクト
  // ユーザーリクエストのLinear, Vercel, Notion含む
  // =========================================================================
  {
    domain: 'linear.app',
    tier: 'ultra-heavy',
    category: 'product',
    libraries: ['three.js'],
    notes: 'ユーザー報告のタイムアウトサイト',
  },
  {
    domain: 'vercel.com',
    tier: 'heavy',
    category: 'product',
    libraries: ['three.js'],
    notes: 'ユーザー報告のタイムアウトサイト',
  },
  {
    domain: 'notion.so',
    tier: 'heavy',
    category: 'product',
    notes: 'ユーザー報告のタイムアウトサイト',
  },
  {
    domain: 'stripe.com',
    tier: 'heavy',
    category: 'product',
    libraries: ['three.js'],
  },
  {
    domain: 'github.com',
    tier: 'webgl',
    category: 'product',
    notes: 'コントリビューションアニメーション',
  },
  {
    domain: 'figma.com',
    tier: 'heavy',
    category: 'product',
    libraries: ['webgl'],
  },
  {
    domain: 'framer.com',
    tier: 'heavy',
    category: 'product',
  },
  {
    domain: 'raycast.com',
    tier: 'heavy',
    category: 'product',
  },
  {
    domain: 'arc.net',
    tier: 'heavy',
    category: 'product',
  },
  {
    domain: 'loom.com',
    tier: 'webgl',
    category: 'product',
  },
  {
    domain: 'watsco.com',
    tier: 'heavy',
    category: 'product',
  },

  // =========================================================================
  // 3D/WebGL実験サイト
  // Three.js公式、クリエイティブコーディング
  // =========================================================================
  {
    domain: 'threejs.org',
    tier: 'heavy',
    category: 'experiment',
    libraries: ['three.js'],
  },
  {
    domain: 'bruno-simon.com',
    tier: 'heavy',
    category: 'experiment',
    libraries: ['three.js'],
  },
  {
    domain: 'webglfundamentals.org',
    tier: 'heavy',
    category: 'experiment',
  },

  // =========================================================================
  // ポートフォリオ/個人サイト
  // 有名クリエイターのサイト
  // =========================================================================
  {
    domain: 'robinnoguier.com',
    tier: 'heavy',
    category: 'portfolio',
  },
  {
    domain: 'patrickheng.com',
    tier: 'ultra-heavy',
    category: 'portfolio',
    libraries: ['three.js'],
  },
  {
    domain: 'midwam.com',
    tier: 'heavy',
    category: 'portfolio',
  },
  {
    domain: 'lusion.co',
    tier: 'ultra-heavy',
    category: 'portfolio',
    libraries: ['three.js'],
  },
  {
    domain: 'iamlegend.co.nz',
    tier: 'ultra-heavy',
    category: 'portfolio',
    libraries: ['three.js'],
  },

  // =========================================================================
  // 日本のWebデザインエージェンシー
  // =========================================================================
  {
    domain: 'baigie.me',
    tier: 'webgl',
    category: 'agency',
    notes: '日本',
  },
  {
    domain: 'fourdigit.jp',
    tier: 'webgl',
    category: 'agency',
    notes: '日本',
  },
  {
    domain: 'goodpatch.com',
    tier: 'webgl',
    category: 'agency',
    notes: '日本',
  },
] as const;

// ============================================================================
// ドメイン検索用のMap
// ============================================================================

/**
 * ドメイン名からエントリを高速に検索するためのMap
 *
 * O(1)でドメイン検索が可能
 */
export const WEBGL_DOMAIN_MAP: Map<string, WebGLDomainEntry> = new Map(
  KNOWN_WEBGL_DOMAINS.map((entry) => [entry.domain, entry])
);

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * カテゴリ別にドメインを取得
 *
 * @param category - 検索するカテゴリ
 * @returns 指定カテゴリのドメインエントリ配列
 *
 * @example
 * ```typescript
 * const awardSites = getDomainsByCategory('award_gallery');
 * // [{ domain: 'awwwards.com', tier: 'heavy', category: 'award_gallery', ... }, ...]
 * ```
 */
export function getDomainsByCategory(
  category: WebGLDomainEntry['category']
): WebGLDomainEntry[] {
  return KNOWN_WEBGL_DOMAINS.filter((entry) => entry.category === category);
}

/**
 * Tier別にドメインを取得
 *
 * @param tier - 検索するTier
 * @returns 指定Tierのドメインエントリ配列
 *
 * @example
 * ```typescript
 * const ultraHeavySites = getDomainsByTier('ultra-heavy');
 * // [{ domain: 'resn.co.nz', tier: 'ultra-heavy', ... }, ...]
 * ```
 */
export function getDomainsByTier(
  tier: WebGLDomainEntry['tier']
): WebGLDomainEntry[] {
  return KNOWN_WEBGL_DOMAINS.filter((entry) => entry.tier === tier);
}

/**
 * ドメイン名またはURLからエントリを取得
 *
 * www.プレフィックスを自動で除去し、大文字小文字を区別せずに検索
 *
 * @param input - ドメイン名またはURL
 * @returns ドメインエントリ（見つからない場合はundefined）
 *
 * @example
 * ```typescript
 * getDomainEntry('resn.co.nz'); // { domain: 'resn.co.nz', tier: 'ultra-heavy', ... }
 * getDomainEntry('www.resn.co.nz'); // { domain: 'resn.co.nz', tier: 'ultra-heavy', ... }
 * getDomainEntry('https://linear.app/team'); // { domain: 'linear.app', tier: 'ultra-heavy', ... }
 * getDomainEntry('google.com'); // undefined
 * ```
 */
export function getDomainEntry(input: string): WebGLDomainEntry | undefined {
  if (!input || typeof input !== 'string') {
    return undefined;
  }

  const domain = extractAndNormalizeDomain(input);
  if (!domain) {
    return undefined;
  }

  return WEBGL_DOMAIN_MAP.get(domain);
}

/**
 * ドメインがリストに含まれているかを確認
 *
 * @param input - ドメイン名またはURL
 * @returns リストに含まれている場合はtrue
 *
 * @example
 * ```typescript
 * isDomainInList('resn.co.nz'); // true
 * isDomainInList('https://linear.app/team'); // true
 * isDomainInList('google.com'); // false
 * ```
 */
export function isDomainInList(input: string): boolean {
  return getDomainEntry(input) !== undefined;
}

/**
 * 入力文字列からドメインを抽出して正規化
 *
 * @param input - ドメイン名またはURL
 * @returns 正規化されたドメイン名（抽出できない場合はnull）
 */
function extractAndNormalizeDomain(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  try {
    // URLかどうかを判定
    let domain: string;

    if (input.includes('://')) {
      // URL形式の場合
      const url = new URL(input);
      domain = url.hostname;
    } else if (input.includes('/')) {
      // パス付きだがプロトコルなしの場合
      const url = new URL('https://' + input);
      domain = url.hostname;
    } else {
      // ドメイン名のみの場合
      domain = input;
    }

    // 正規化
    domain = domain.toLowerCase();
    if (domain.startsWith('www.')) {
      domain = domain.slice(4);
    }

    return domain;
  } catch {
    // URLパースに失敗した場合は単純な正規化を試みる
    let domain = input.toLowerCase();
    if (domain.startsWith('www.')) {
      domain = domain.slice(4);
    }
    return domain;
  }
}

// ============================================================================
// 後方互換性用エクスポート
// ============================================================================

/**
 * 既存のwebgl-pre-detector.tsとの互換性のため、
 * 配列形式のドメインリストもエクスポート
 */

/**
 * ultra-heavyドメイン一覧（後方互換性用）
 * @deprecated Use getDomainsByTier('ultra-heavy') instead
 */
export const LEGACY_ULTRA_HEAVY_DOMAINS: readonly string[] = getDomainsByTier(
  'ultra-heavy'
).map((e) => e.domain);

/**
 * heavyドメイン一覧（後方互換性用）
 * @deprecated Use getDomainsByTier('heavy') instead
 */
export const LEGACY_HEAVY_DOMAINS: readonly string[] = getDomainsByTier(
  'heavy'
).map((e) => e.domain);

/**
 * 全WebGLドメイン一覧（後方互換性用）
 * @deprecated Use KNOWN_WEBGL_DOMAINS instead
 */
export const LEGACY_ALL_DOMAINS: readonly string[] = KNOWN_WEBGL_DOMAINS.map(
  (e) => e.domain
);
