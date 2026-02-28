// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Classification Rules
 *
 * セクション分類のためのルールと条件の型定義
 *
 * @module @reftrix/webdesign-core/section-classifier/rules
 */

import type { SectionType, DetectedSection } from '../types/section.types';

// =========================================
// Classification Condition Types
// =========================================

/**
 * 条件のフィールドタイプ
 */
export type ConditionField =
  | 'tagName'
  | 'classes'
  | 'content'
  | 'position'
  | 'style'
  | 'children'
  | 'id';

/**
 * 条件のオペレータタイプ
 */
export type ConditionOperator =
  | 'contains'
  | 'matches'
  | 'equals'
  | 'range'
  | 'hasAny'
  | 'hasAll';

/**
 * 範囲値の型定義
 */
export interface RangeValue {
  startY?: [number, number];
  endY?: [number, number];
  height?: [number, number];
}

/**
 * 分類条件
 */
export interface ClassificationCondition {
  /** 評価対象フィールド */
  field: ConditionField;
  /** 比較オペレータ */
  operator: ConditionOperator;
  /** 比較値（文字列、数値、正規表現、配列など） */
  value: string | number | RegExp | string[] | RangeValue;
  /** 重み（0-1、条件のconfidenceへの寄与度） */
  weight: number;
}

/**
 * 分類ルール
 */
export interface ClassificationRule {
  /** ターゲットのセクションタイプ */
  type: SectionType;
  /** 優先度（高い方が優先） */
  priority: number;
  /** 分類条件の配列 */
  conditions: ClassificationCondition[];
  /** 最小信頼度（この閾値以上で分類） */
  minConfidence: number;
}

/**
 * 分類結果
 */
export interface ClassificationResult {
  /** 分類されたセクションタイプ */
  type: SectionType;
  /** 信頼度（0-1） */
  confidence: number;
}

/**
 * コンテキスト付き分類結果
 */
export interface ContextualClassificationResult extends ClassificationResult {
  /** 元のセクション参照 */
  section: DetectedSection;
}

// =========================================
// Default Classification Rules
// =========================================

/**
 * デフォルト分類ルール
 *
 * 各セクションタイプに対して複数のルールを定義
 * 優先度が高いルールから評価される
 */
export const defaultRules: ClassificationRule[] = [
  // =========================================
  // Hero Detection Rules (priority 100-110)
  // =========================================
  {
    type: 'hero',
    priority: 110,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bhero\b|\bbanner\b|\bjumbotron\b|\bmasthead\b/i, weight: 0.4 },
      { field: 'content', operator: 'hasAny', value: ['h1'], weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
      { field: 'style', operator: 'hasAny', value: ['backgroundImage', 'gradient'], weight: 0.1 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'hero',
    priority: 105,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bhero\b|\bbanner\b/i, weight: 0.5 },
      { field: 'content', operator: 'hasAny', value: ['h1'], weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'hero',
    priority: 100,
    conditions: [
      { field: 'position', operator: 'range', value: { startY: [0, 200] }, weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['h1'], weight: 0.35 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.25 },
      { field: 'style', operator: 'hasAny', value: ['backgroundImage', 'gradient'], weight: 0.1 },
    ],
    minConfidence: 0.6,
  },

  // =========================================
  // Footer Detection Rules (priority 95-100) - Higher than navigation for footer-specific patterns
  // =========================================
  {
    type: 'footer',
    priority: 100,
    conditions: [
      { field: 'tagName', operator: 'equals', value: 'footer', weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['links'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'footer',
    priority: 98,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bfooter\b|\bsite-footer\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['links'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'footer',
    priority: 96,
    conditions: [
      { field: 'content', operator: 'hasAny', value: ['copyright'], weight: 1.0 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'footer',
    priority: 94,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bbottom\b/i, weight: 0.5 },
      { field: 'content', operator: 'hasAny', value: ['copyright'], weight: 0.5 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Navigation Detection Rules (priority 90-95)
  // =========================================
  {
    type: 'navigation',
    priority: 95,
    conditions: [
      { field: 'tagName', operator: 'equals', value: 'nav', weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['links'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'navigation',
    priority: 93,
    conditions: [
      { field: 'tagName', operator: 'equals', value: 'header', weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['links'], weight: 0.4 },
      { field: 'position', operator: 'range', value: { startY: [0, 100] }, weight: 0.3 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'navigation',
    priority: 90,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bnav\b|\bmenu\b|\bnavigation\b|\bnavbar\b/i, weight: 0.5 },
      { field: 'content', operator: 'hasAny', value: ['links'], weight: 0.5 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Pricing Detection Rules (priority 85-88)
  // =========================================
  {
    type: 'pricing',
    priority: 88,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bpricings?\b|\bprices?\b|\bplans?\b|\bpackages?\b|\bsubscriptions?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'pricing',
    priority: 85,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bpricings?\b|\bprices?\b|\bplans?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Gallery Detection Rules (priority 82-85) - Higher priority than feature for gallery patterns
  // =========================================
  {
    type: 'gallery',
    priority: 85,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bgallery\b|\bportfolio\b|\bshowcase\b/i, weight: 1.0 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'gallery',
    priority: 83,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bgallery\b|\bportfolio\b|\bshowcase\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['multipleImages'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'gallery',
    priority: 80,
    conditions: [
      { field: 'content', operator: 'hasAny', value: ['manyImages'], weight: 1.0 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Testimonial Detection Rules (priority 78-82)
  // =========================================
  {
    type: 'testimonial',
    priority: 82,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\btestimonials?\b|\breviews?\b|\bquotes?\b|\bcustomers?\b|\bfeedback\b/i, weight: 0.7 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.3 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'testimonial',
    priority: 78,
    conditions: [
      { field: 'id', operator: 'matches', value: /\btestimonials?\b|\breviews?\b/i, weight: 0.7 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.3 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // About Detection Rules (priority 75-78) - Higher priority than feature for about patterns
  // =========================================
  {
    type: 'about',
    priority: 78,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\babout\b|\bcompany\b|\bwho-we-are\b|\bour-story\b/i, weight: 1.0 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'about',
    priority: 76,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bteam\b|\bour-team\b|\bstory\b/i, weight: 1.0 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'about',
    priority: 74,
    conditions: [
      { field: 'id', operator: 'matches', value: /\babout\b|\bcompany\b|\bteam\b/i, weight: 0.7 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.3 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // CTA Detection Rules (priority 72-75)
  // =========================================
  {
    type: 'cta',
    priority: 75,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bcta\b|\bcall-to-action\b|\baction\b|\bsignup\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'cta',
    priority: 72,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bcta\b|\baction\b|\bsignup\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Contact Detection Rules (priority 70-73)
  // =========================================
  {
    type: 'contact',
    priority: 73,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bcontact\b|\bget-in-touch\b|\breach\b/i, weight: 1.0 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'contact',
    priority: 71,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bcontact\b|\breach\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'contact',
    priority: 70,
    conditions: [
      { field: 'content', operator: 'hasAny', value: ['email'], weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Feature Detection Rules (priority 65-70) - Lower priority as catch-all
  // =========================================
  {
    type: 'feature',
    priority: 70,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bfeatures?\b|\bbenefits?\b|\bservices?\b/i, weight: 0.5 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'feature',
    priority: 68,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bgrid\b|\bcolumn\b/i, weight: 0.4 },
      { field: 'content', operator: 'hasAny', value: ['multipleHeadings'], weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['multipleImages'], weight: 0.3 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'feature',
    priority: 65,
    conditions: [
      { field: 'content', operator: 'hasAll', value: ['multipleHeadings', 'multipleImages'], weight: 0.7 },
      { field: 'content', operator: 'hasAny', value: ['paragraphs'], weight: 0.3 },
    ],
    minConfidence: 0.6,
  },

  // =========================================
  // Partners Detection Rules (priority 60-63)
  // パートナー・クライアントロゴセクション
  // =========================================
  {
    type: 'partners',
    priority: 63,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bpartners?\b|\bclients?\b|\bsponsors?\b|\btrusted\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'partners',
    priority: 61,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bpartners?\b|\bclients?\b|\bsponsors?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['multipleImages'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'partners',
    priority: 60,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\blogos?\b|\bbrands?\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['manyImages'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Portfolio Detection Rules (priority 57-60)
  // ポートフォリオ・実績セクション
  // =========================================
  {
    type: 'portfolio',
    priority: 60,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bportfolio\b|\bworks?\b|\bprojects?\b|\bcase-stud/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'portfolio',
    priority: 58,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bportfolio\b|\bworks?\b|\bprojects?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['multipleImages'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'portfolio',
    priority: 57,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bcase\b|\bachievements?\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Team Detection Rules (priority 54-57)
  // チーム・メンバー紹介セクション
  // =========================================
  {
    type: 'team',
    priority: 57,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bteam\b|\bmembers?\b|\bpeople\b|\bstaff\b|\bleadership\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'team',
    priority: 55,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bteam\b|\bmembers?\b|\bpeople\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['multipleImages'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'team',
    priority: 54,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bexecutives?\b|\bfounders?\b|\bcrew\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Stories Detection Rules (priority 51-54)
  // ストーリー・事例紹介セクション
  // =========================================
  {
    type: 'stories',
    priority: 54,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bstories?\b|\bcase-studies?\b|\bsuccess\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'stories',
    priority: 52,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bstories?\b|\bcases?\b|\bsuccess\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['paragraphs'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'stories',
    priority: 51,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bexamples?\b|\bhighlights?\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
      { field: 'content', operator: 'hasAny', value: ['paragraphs'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Research Detection Rules (priority 48-51)
  // リサーチ・調査結果セクション
  // =========================================
  {
    type: 'research',
    priority: 51,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bresearch\b|\bstudies?\b|\binsights?\b|\bfindings?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'research',
    priority: 49,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bresearch\b|\bstudies?\b|\binsights?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['paragraphs'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'research',
    priority: 48,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\breports?\b|\banalytics?\b|\bdata\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
      { field: 'content', operator: 'hasAny', value: ['images'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Subscribe Detection Rules (priority 45-48)
  // 購読・ニュースレター登録セクション
  // =========================================
  {
    type: 'subscribe',
    priority: 48,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bsubscribe\b|\bnewsletter\b|\bmail-?list\b|\bsign-?up\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'subscribe',
    priority: 46,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bsubscribe\b|\bnewsletter\b|\bmail-?list\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'subscribe',
    priority: 45,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bemail\b|\bupdates?\b|\bnotify\b/i, weight: 0.5 },
      { field: 'content', operator: 'hasAny', value: ['email'], weight: 0.3 },
      { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // Stats Detection Rules (priority 42-45)
  // 統計・数値実績セクション
  // =========================================
  {
    type: 'stats',
    priority: 45,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bstats?\b|\bstatistics?\b|\bnumbers?\b|\bmetrics?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'stats',
    priority: 43,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bstats?\b|\bstatistics?\b|\bnumbers?\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'stats',
    priority: 42,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bcounters?\b|\bachievements?\b|\bfigures?\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['multipleHeadings'], weight: 0.4 },
    ],
    minConfidence: 0.5,
  },

  // =========================================
  // FAQ Detection Rules (priority 39-42)
  // よくある質問セクション
  // =========================================
  {
    type: 'faq',
    priority: 42,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\bfaq\b|\bfrequently\b|\bquestions?\b|\bhelp\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'faq',
    priority: 40,
    conditions: [
      { field: 'id', operator: 'matches', value: /\bfaq\b|\bquestions?\b|\bhelp\b/i, weight: 0.8 },
      { field: 'content', operator: 'hasAny', value: ['headings'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
  {
    type: 'faq',
    priority: 39,
    conditions: [
      { field: 'classes', operator: 'matches', value: /\baccordion\b|\bcollapse\b|\bq-?and-?a\b/i, weight: 0.6 },
      { field: 'content', operator: 'hasAny', value: ['multipleHeadings'], weight: 0.2 },
      { field: 'content', operator: 'hasAny', value: ['paragraphs'], weight: 0.2 },
    ],
    minConfidence: 0.5,
  },
];
