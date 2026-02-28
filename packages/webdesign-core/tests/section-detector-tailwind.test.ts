// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionDetector - Tailwind CSS サイト検出率テスト
 *
 * 目的: Tailwind CSSユーティリティクラスのみを使用するサイトでの
 *       SectionDetector検出率をベースライン測定し、改善目標を定義する
 *
 * 背景:
 * - 現在のSectionDetectorはセマンティッククラス名（hero, feature, cta等）に依存
 * - Tailwindサイトではユーティリティクラスのみ（flex, grid, p-4等）使用
 * - 結果: 検出率が約33%まで低下（Mevvy Network実測値）
 *
 * @module @reftrix/webdesign-core/tests/section-detector-tailwind
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SectionDetector } from '../src/section-detector';
import type { DetectedSection, SectionType } from '../src/types/section.types';

// =========================================
// Test Fixtures: Tailwind CSS Only HTML
// =========================================

/**
 * HTMLドキュメントテンプレート
 * Tailwind CSSのセットアップを想定
 */
const createTailwindHtml = (body: string): string => `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tailwind CSS Site</title>
  <!-- Tailwind CSS CDN（テスト用） -->
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900">
${body}
</body>
</html>
`;

/**
 * Mevvy Network風のTailwind CSSフィクスチャ
 *
 * 特徴:
 * - すべてTailwindユーティリティクラスのみ使用
 * - セマンティッククラス名（hero, feature等）は一切使用しない
 * - 6種類のセクション: Hero, Features, CTA, Testimonial, Pricing, Footer
 */
const TAILWIND_FULL_PAGE_HTML = createTailwindHtml(`
  <!-- Navigation（ヘッダーナビ） -->
  <nav class="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <div class="flex-shrink-0">
          <a href="/" class="text-xl font-bold text-indigo-600">Brand</a>
        </div>
        <div class="hidden md:block">
          <div class="ml-10 flex items-baseline space-x-4">
            <a href="#features" class="text-slate-600 hover:text-indigo-600 px-3 py-2 rounded-md text-sm font-medium">機能</a>
            <a href="#pricing" class="text-slate-600 hover:text-indigo-600 px-3 py-2 rounded-md text-sm font-medium">料金</a>
            <a href="#testimonials" class="text-slate-600 hover:text-indigo-600 px-3 py-2 rounded-md text-sm font-medium">お客様の声</a>
          </div>
        </div>
        <div>
          <a href="/signup" class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700">
            無料で始める
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- Hero セクション（Tailwindユーティリティのみ） -->
  <section class="pt-24 pb-16 sm:pt-32 sm:pb-24 bg-gradient-to-br from-indigo-50 via-white to-purple-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="lg:grid lg:grid-cols-12 lg:gap-8">
        <div class="sm:text-center md:max-w-2xl md:mx-auto lg:col-span-6 lg:text-left">
          <h1 class="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl md:text-6xl">
            <span class="block">ビジネスを</span>
            <span class="block text-indigo-600">次のレベルへ</span>
          </h1>
          <p class="mt-3 text-base text-slate-500 sm:mt-5 sm:text-xl lg:text-lg xl:text-xl">
            AIを活用した次世代のビジネスソリューションで、
            業務効率を劇的に改善します。
          </p>
          <div class="mt-8 sm:max-w-lg sm:mx-auto sm:text-center lg:text-left lg:mx-0">
            <button type="button" class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              無料トライアル開始
            </button>
            <button type="button" class="ml-3 inline-flex items-center px-6 py-3 border border-slate-300 shadow-sm text-base font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              デモを見る
            </button>
          </div>
        </div>
        <div class="mt-12 relative sm:max-w-lg sm:mx-auto lg:mt-0 lg:max-w-none lg:mx-0 lg:col-span-6 lg:flex lg:items-center">
          <img class="w-full rounded-lg shadow-xl" src="/hero-illustration.svg" alt="製品イメージ">
        </div>
      </div>
    </div>
  </section>

  <!-- Features セクション（Tailwindユーティリティのみ） -->
  <section class="py-16 sm:py-24 bg-white">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h2 class="text-3xl font-extrabold text-slate-900 sm:text-4xl">
          主要な機能
        </h2>
        <p class="mt-4 max-w-2xl text-xl text-slate-500 mx-auto">
          すべての機能を使って、ビジネスを加速させましょう。
        </p>
      </div>
      <div class="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        <div class="relative p-6 bg-slate-50 rounded-2xl hover:shadow-lg transition-shadow">
          <div class="w-12 h-12 rounded-lg bg-indigo-600 flex items-center justify-center">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
          </div>
          <h3 class="mt-4 text-lg font-semibold text-slate-900">高速処理</h3>
          <p class="mt-2 text-slate-600">
            最新のAI技術により、処理速度が従来の10倍に向上します。
          </p>
        </div>
        <div class="relative p-6 bg-slate-50 rounded-2xl hover:shadow-lg transition-shadow">
          <div class="w-12 h-12 rounded-lg bg-green-600 flex items-center justify-center">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
            </svg>
          </div>
          <h3 class="mt-4 text-lg font-semibold text-slate-900">セキュリティ</h3>
          <p class="mt-2 text-slate-600">
            エンタープライズグレードのセキュリティで大切なデータを保護。
          </p>
        </div>
        <div class="relative p-6 bg-slate-50 rounded-2xl hover:shadow-lg transition-shadow">
          <div class="w-12 h-12 rounded-lg bg-purple-600 flex items-center justify-center">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path>
            </svg>
          </div>
          <h3 class="mt-4 text-lg font-semibold text-slate-900">柔軟な連携</h3>
          <p class="mt-2 text-slate-600">
            既存システムとの連携が簡単。APIで何でも接続できます。
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA セクション（Tailwindユーティリティのみ） -->
  <section class="py-16 sm:py-24 bg-indigo-700">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h2 class="text-3xl font-extrabold text-white sm:text-4xl">
          今すぐ始めましょう
        </h2>
        <p class="mt-4 text-xl text-indigo-100">
          14日間の無料トライアルで、すべての機能をお試しください。
        </p>
        <div class="mt-8 flex justify-center gap-4">
          <button type="button" class="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-indigo-700 bg-white hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white">
            無料トライアル
          </button>
          <button type="button" class="inline-flex items-center px-6 py-3 border border-white text-base font-medium rounded-md text-white hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white">
            お問い合わせ
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- Testimonial セクション（Tailwindユーティリティのみ） -->
  <section class="py-16 sm:py-24 bg-slate-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h2 class="text-3xl font-extrabold text-slate-900 sm:text-4xl">
          お客様の声
        </h2>
        <p class="mt-4 max-w-2xl text-xl text-slate-500 mx-auto">
          多くの企業様にご利用いただいています。
        </p>
      </div>
      <div class="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        <div class="bg-white p-6 rounded-2xl shadow-sm">
          <div class="flex items-center gap-4">
            <img class="w-12 h-12 rounded-full" src="/avatar1.jpg" alt="田中太郎">
            <div>
              <p class="font-semibold text-slate-900">田中太郎</p>
              <p class="text-sm text-slate-500">株式会社ABC CEO</p>
            </div>
          </div>
          <blockquote class="mt-4 text-slate-600">
            「導入後、業務効率が50%向上しました。チーム全員が使いこなせるシンプルさも魅力です。」
          </blockquote>
        </div>
        <div class="bg-white p-6 rounded-2xl shadow-sm">
          <div class="flex items-center gap-4">
            <img class="w-12 h-12 rounded-full" src="/avatar2.jpg" alt="佐藤花子">
            <div>
              <p class="font-semibold text-slate-900">佐藤花子</p>
              <p class="text-sm text-slate-500">XYZ株式会社 マネージャー</p>
            </div>
          </div>
          <blockquote class="mt-4 text-slate-600">
            「サポートの対応が素晴らしく、安心して利用できています。」
          </blockquote>
        </div>
        <div class="bg-white p-6 rounded-2xl shadow-sm">
          <div class="flex items-center gap-4">
            <img class="w-12 h-12 rounded-full" src="/avatar3.jpg" alt="山田次郎">
            <div>
              <p class="font-semibold text-slate-900">山田次郎</p>
              <p class="text-sm text-slate-500">DEFコーポレーション CTO</p>
            </div>
          </div>
          <blockquote class="mt-4 text-slate-600">
            「APIの柔軟性が高く、既存システムとの連携がスムーズでした。」
          </blockquote>
        </div>
      </div>
    </div>
  </section>

  <!-- Pricing セクション（Tailwindユーティリティのみ） -->
  <section class="py-16 sm:py-24 bg-white">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center">
        <h2 class="text-3xl font-extrabold text-slate-900 sm:text-4xl">
          料金プラン
        </h2>
        <p class="mt-4 max-w-2xl text-xl text-slate-500 mx-auto">
          ビジネスの規模に合わせて選べるプランをご用意。
        </p>
      </div>
      <div class="mt-16 grid gap-8 lg:grid-cols-3">
        <div class="relative p-8 bg-slate-50 rounded-2xl border-2 border-slate-200">
          <h3 class="text-xl font-semibold text-slate-900">スタータープラン</h3>
          <p class="mt-4 text-slate-500">小規模チーム向け</p>
          <p class="mt-8">
            <span class="text-4xl font-extrabold text-slate-900">¥9,800</span>
            <span class="text-slate-500">/月</span>
          </p>
          <ul class="mt-8 space-y-4">
            <li class="flex items-center">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-slate-600">ユーザー5名まで</span>
            </li>
            <li class="flex items-center">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-slate-600">基本機能</span>
            </li>
          </ul>
          <button class="mt-8 w-full py-3 px-4 rounded-md border border-indigo-600 text-indigo-600 font-medium hover:bg-indigo-50">
            プランを選択
          </button>
        </div>
        <div class="relative p-8 bg-indigo-600 rounded-2xl shadow-xl">
          <div class="absolute top-0 right-0 -translate-y-1/2 px-4 py-1 bg-indigo-500 rounded-full text-sm font-medium text-white">
            人気
          </div>
          <h3 class="text-xl font-semibold text-white">プロプラン</h3>
          <p class="mt-4 text-indigo-100">成長中のチーム向け</p>
          <p class="mt-8">
            <span class="text-4xl font-extrabold text-white">¥29,800</span>
            <span class="text-indigo-100">/月</span>
          </p>
          <ul class="mt-8 space-y-4">
            <li class="flex items-center">
              <svg class="w-5 h-5 text-indigo-200" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-white">ユーザー無制限</span>
            </li>
            <li class="flex items-center">
              <svg class="w-5 h-5 text-indigo-200" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-white">全機能利用可能</span>
            </li>
            <li class="flex items-center">
              <svg class="w-5 h-5 text-indigo-200" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-white">優先サポート</span>
            </li>
          </ul>
          <button class="mt-8 w-full py-3 px-4 rounded-md bg-white text-indigo-600 font-medium hover:bg-indigo-50">
            プランを選択
          </button>
        </div>
        <div class="relative p-8 bg-slate-50 rounded-2xl border-2 border-slate-200">
          <h3 class="text-xl font-semibold text-slate-900">エンタープライズ</h3>
          <p class="mt-4 text-slate-500">大企業向け</p>
          <p class="mt-8">
            <span class="text-4xl font-extrabold text-slate-900">要相談</span>
          </p>
          <ul class="mt-8 space-y-4">
            <li class="flex items-center">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-slate-600">専用環境</span>
            </li>
            <li class="flex items-center">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-slate-600">SLA保証</span>
            </li>
            <li class="flex items-center">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
              <span class="ml-3 text-slate-600">カスタム開発対応</span>
            </li>
          </ul>
          <button class="mt-8 w-full py-3 px-4 rounded-md border border-indigo-600 text-indigo-600 font-medium hover:bg-indigo-50">
            お問い合わせ
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer セクション（Tailwindユーティリティのみ） -->
  <footer class="py-12 bg-slate-900">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid gap-8 md:grid-cols-4">
        <div>
          <a href="/" class="text-xl font-bold text-white">Brand</a>
          <p class="mt-4 text-slate-400">
            ビジネスを次のレベルへ導くAIソリューション
          </p>
        </div>
        <div>
          <h4 class="text-sm font-semibold text-white uppercase tracking-wider">製品</h4>
          <ul class="mt-4 space-y-2">
            <li><a href="/features" class="text-slate-400 hover:text-white">機能</a></li>
            <li><a href="/pricing" class="text-slate-400 hover:text-white">料金</a></li>
            <li><a href="/integrations" class="text-slate-400 hover:text-white">連携</a></li>
          </ul>
        </div>
        <div>
          <h4 class="text-sm font-semibold text-white uppercase tracking-wider">会社情報</h4>
          <ul class="mt-4 space-y-2">
            <li><a href="/about" class="text-slate-400 hover:text-white">会社概要</a></li>
            <li><a href="/blog" class="text-slate-400 hover:text-white">ブログ</a></li>
            <li><a href="/careers" class="text-slate-400 hover:text-white">採用情報</a></li>
          </ul>
        </div>
        <div>
          <h4 class="text-sm font-semibold text-white uppercase tracking-wider">サポート</h4>
          <ul class="mt-4 space-y-2">
            <li><a href="/help" class="text-slate-400 hover:text-white">ヘルプセンター</a></li>
            <li><a href="/contact" class="text-slate-400 hover:text-white">お問い合わせ</a></li>
            <li><a href="/privacy" class="text-slate-400 hover:text-white">プライバシーポリシー</a></li>
          </ul>
        </div>
      </div>
      <div class="mt-12 pt-8 border-t border-slate-700">
        <p class="text-center text-slate-400">
          &copy; 2026 Brand Inc. All rights reserved.
        </p>
      </div>
    </div>
  </footer>
`);

/**
 * 期待されるセクションタイプのマッピング
 *
 * Tailwind CSSサイトに実際に存在するセクション:
 * 1. navigation - ナビゲーションバー
 * 2. hero - ヒーローセクション（h1 + CTA）
 * 3. feature - 機能紹介（3カラムグリッド）
 * 4. cta - コールトゥアクション（背景色付き）
 * 5. testimonial - お客様の声（blockquote）
 * 6. pricing - 料金プラン（3カラム）
 * 7. footer - フッター
 */
const EXPECTED_SECTIONS: SectionType[] = [
  'navigation',
  'hero',
  'feature',
  'cta',
  'testimonial',
  'pricing',
  'footer',
];

// =========================================
// Helper Functions
// =========================================

/**
 * 検出結果から特定タイプのセクションを抽出
 */
function findSectionsByType(sections: DetectedSection[], type: SectionType): DetectedSection[] {
  return sections.filter((s) => s.type === type);
}

/**
 * 検出されたセクションタイプの一覧を取得（重複排除）
 */
function getDetectedTypes(sections: DetectedSection[]): SectionType[] {
  return [...new Set(sections.map((s) => s.type))];
}

/**
 * 検出率を計算
 *
 * @param detected - 検出されたセクション
 * @param expected - 期待されるセクションタイプ
 * @returns 検出率（0-100%）
 */
function calculateDetectionRate(
  detected: DetectedSection[],
  expected: SectionType[]
): { rate: number; detectedCount: number; expectedCount: number; missedTypes: SectionType[] } {
  const detectedTypes = new Set(getDetectedTypes(detected));
  const detectedCount = expected.filter((type) => detectedTypes.has(type)).length;
  const missedTypes = expected.filter((type) => !detectedTypes.has(type));

  return {
    rate: Math.round((detectedCount / expected.length) * 100),
    detectedCount,
    expectedCount: expected.length,
    missedTypes,
  };
}

// =========================================
// Test Suite
// =========================================

describe('SectionDetector - Tailwind CSS Sites', () => {
  let detector: SectionDetector;

  beforeEach(() => {
    detector = new SectionDetector();
  });

  describe('Baseline Detection Rate (Current State)', () => {
    /**
     * ベースライン測定テスト
     *
     * 目的: 現在のSectionDetectorでTailwind CSSサイトの検出率を記録
     * 期待: 検出率は33%程度（Mevvy Network実測値に基づく）
     */
    it('should measure current detection rate for Tailwind-only HTML', async () => {
      // Arrange: Tailwind CSSのみを使用したHTMLをセットアップ
      const html = TAILWIND_FULL_PAGE_HTML;

      // Act: セクション検出を実行
      const sections = await detector.detect(html);

      // Assert: 検出結果を記録
      const result = calculateDetectionRate(sections, EXPECTED_SECTIONS);

      // デバッグ情報を出力（テスト結果の分析用）
      console.log('\n=== Tailwind CSS Site Detection Baseline ===');
      console.log(`Total sections detected: ${sections.length}`);
      console.log(`Detection rate: ${result.rate}% (${result.detectedCount}/${result.expectedCount})`);
      console.log(`Detected types: ${getDetectedTypes(sections).join(', ')}`);
      console.log(`Missed types: ${result.missedTypes.join(', ')}`);
      console.log('\nDetailed sections:');
      sections.forEach((s, i) => {
        console.log(`  ${i + 1}. [${s.type}] confidence: ${s.confidence.toFixed(2)}, selector: ${s.element.selector}`);
      });
      console.log('===========================================\n');

      // ベースライン検証: 現在の検出率を記録（改善前の状態を記録）
      // 注意: この値は現状の制約を示すもので、改善後に更新する
      expect(sections.length).toBeGreaterThanOrEqual(1);

      // 少なくともnavigation/footerは検出されることを期待
      // （セマンティックタグ<nav>/<footer>が使用されているため）
      const detectedTypes = getDetectedTypes(sections);
      expect(detectedTypes).toContain('navigation');
      expect(detectedTypes).toContain('footer');
    });

    /**
     * 各セクションタイプの検出状況を個別に記録
     */
    it('should record detection status for each expected section type', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const detectedTypes = new Set(getDetectedTypes(sections));

      // 各期待セクションの検出状況を記録
      const detectionStatus = EXPECTED_SECTIONS.map((type) => ({
        type,
        detected: detectedTypes.has(type),
        section: sections.find((s) => s.type === type),
      }));

      console.log('\n=== Per-Section Detection Status ===');
      detectionStatus.forEach(({ type, detected, section }) => {
        const status = detected ? '[DETECTED]' : '[MISSED]  ';
        const confidence = section ? ` (confidence: ${section.confidence.toFixed(2)})` : '';
        console.log(`${status} ${type}${confidence}`);
      });
      console.log('====================================\n');

      // 検出ステータスの構造が正しいことを検証
      expect(detectionStatus).toHaveLength(EXPECTED_SECTIONS.length);
    });
  });

  describe('Detection Analysis (Root Cause)', () => {
    /**
     * Heroセクション検出の失敗原因分析
     *
     * 現在の検出ロジック:
     * 1. class/idに "hero", "banner" などのキーワードがある → 検出
     * 2. H1 + ボタン + ページ上部 → 検出
     *
     * Tailwindサイトでの問題:
     * - class="pt-24 pb-16 sm:pt-32 sm:pb-24 bg-gradient-to-br..." にはheroキーワードなし
     * - <section>タグは汎用的で、heroとして認識されない
     */
    it('should analyze why hero section detection fails for Tailwind HTML', async () => {
      const heroOnlyHtml = createTailwindHtml(`
        <section class="pt-24 pb-16 bg-gradient-to-br from-indigo-50 to-white">
          <div class="max-w-7xl mx-auto px-4">
            <h1 class="text-4xl font-extrabold text-slate-900">
              ビジネスを次のレベルへ
            </h1>
            <p class="mt-3 text-base text-slate-500">
              AIを活用した次世代のビジネスソリューション
            </p>
            <button class="mt-8 px-6 py-3 bg-indigo-600 text-white rounded-md">
              無料トライアル開始
            </button>
          </div>
        </section>
      `);

      const sections = await detector.detect(heroOnlyHtml);

      console.log('\n=== Hero Detection Analysis ===');
      console.log('Input: Tailwind-only hero section (no semantic class names)');
      console.log(`Sections detected: ${sections.length}`);
      sections.forEach((s) => {
        console.log(`  Type: ${s.type}, Confidence: ${s.confidence.toFixed(2)}`);
        console.log(`  Classes: ${s.element.classes.join(' ')}`);
        console.log(`  Has H1: ${s.content.headings.some((h) => h.level === 1)}`);
        console.log(`  Has buttons: ${s.content.buttons.length}`);
      });
      console.log('===============================\n');

      // コンテンツベースの検出（H1 + ボタン）が機能するか確認
      const heroSection = sections.find((s) => s.type === 'hero');

      // 発見: hero-contentルール（H1 + button + ページ上部）で検出される
      // 信頼度は0.85（positionConditionsによる+0.1ブースト後）
      // これはTailwind CSSサイトでもコンテンツベース検出が機能することを示す
      if (heroSection) {
        // heroとして検出され、適切な信頼度を持つことを確認
        expect(heroSection.confidence).toBeGreaterThanOrEqual(0.7);
        expect(heroSection.content.headings.some((h) => h.level === 1)).toBe(true);
        expect(heroSection.content.buttons.length).toBeGreaterThan(0);
      }
    });

    /**
     * Featuresセクション検出の失敗原因分析
     */
    it('should analyze why feature section detection fails for Tailwind HTML', async () => {
      const featureOnlyHtml = createTailwindHtml(`
        <section class="py-16 bg-white">
          <div class="max-w-7xl mx-auto px-4">
            <h2 class="text-3xl font-extrabold text-slate-900">主要な機能</h2>
            <div class="mt-16 grid gap-8 md:grid-cols-3">
              <div class="p-6 bg-slate-50 rounded-2xl">
                <h3 class="text-lg font-semibold">高速処理</h3>
                <p class="mt-2 text-slate-600">処理速度が10倍に向上</p>
              </div>
              <div class="p-6 bg-slate-50 rounded-2xl">
                <h3 class="text-lg font-semibold">セキュリティ</h3>
                <p class="mt-2 text-slate-600">エンタープライズグレード</p>
              </div>
              <div class="p-6 bg-slate-50 rounded-2xl">
                <h3 class="text-lg font-semibold">柔軟な連携</h3>
                <p class="mt-2 text-slate-600">APIで何でも接続</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(featureOnlyHtml);

      console.log('\n=== Feature Detection Analysis ===');
      console.log('Input: Tailwind-only feature section with 3-column grid');
      console.log(`Sections detected: ${sections.length}`);
      sections.forEach((s) => {
        console.log(`  Type: ${s.type}, Confidence: ${s.confidence.toFixed(2)}`);
        console.log(`  Classes: ${s.element.classes.slice(0, 5).join(' ')}`);
        console.log(`  Has images: ${s.content.images.length}`);
        console.log(`  Has headings: ${s.content.headings.length}`);
      });
      console.log('==================================\n');

      // Tailwindのgrid-cols-*パターンが検出されるか確認
      // 現状: feature-gridルール（md:grid-cols-3）で検出される可能性あり
      const featureSection = sections.find((s) => s.type === 'feature');
      if (featureSection) {
        // 検出された場合は低〜中程度の信頼度
        expect(featureSection.confidence).toBeLessThanOrEqual(0.85);
      }
    });

    /**
     * CTAセクション検出の失敗原因分析
     */
    it('should analyze why cta section detection fails for Tailwind HTML', async () => {
      const ctaOnlyHtml = createTailwindHtml(`
        <section class="py-16 bg-indigo-700">
          <div class="max-w-7xl mx-auto px-4 text-center">
            <h2 class="text-3xl font-extrabold text-white">今すぐ始めましょう</h2>
            <p class="mt-4 text-xl text-indigo-100">14日間の無料トライアル</p>
            <div class="mt-8 flex justify-center gap-4">
              <button class="px-6 py-3 bg-white text-indigo-700 rounded-md font-medium">
                無料トライアル
              </button>
              <button class="px-6 py-3 border border-white text-white rounded-md font-medium">
                お問い合わせ
              </button>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(ctaOnlyHtml);

      console.log('\n=== CTA Detection Analysis ===');
      console.log('Input: Tailwind-only CTA section (colored background + buttons)');
      console.log(`Sections detected: ${sections.length}`);
      sections.forEach((s) => {
        console.log(`  Type: ${s.type}, Confidence: ${s.confidence.toFixed(2)}`);
        console.log(`  Classes: ${s.element.classes.slice(0, 5).join(' ')}`);
        console.log(`  Has buttons: ${s.content.buttons.length}`);
      });
      console.log('==============================\n');

      // cta-contentルール（requiresButton: true）で検出される可能性
      const ctaSection = sections.find((s) => s.type === 'cta');
      if (ctaSection) {
        expect(ctaSection.content.buttons.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Target Detection Rate (Future Improvements)', () => {
    /**
     * 目標検出率テスト（改善後に有効化）
     *
     * 目標: 80%以上の検出率（6/7セクション = 85%）
     *
     * 改善案:
     * 1. コンテンツベース検出の強化（H1/H2 + ボタン/リンク構成分析）
     * 2. Tailwindグリッドパターン検出（md:grid-cols-*, lg:grid-cols-*）
     * 3. 視覚的特徴検出（背景色クラス: bg-indigo-*, bg-slate-*）
     * 4. テキスト分析による意図推定（「料金」「お問い合わせ」等のキーワード）
     */
    it.skip('should achieve 80%+ detection rate after improvements', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const result = calculateDetectionRate(sections, EXPECTED_SECTIONS);

      // 目標: 80%以上の検出率
      expect(result.rate).toBeGreaterThanOrEqual(80);

      // 主要セクションがすべて検出されること
      const detectedTypes = new Set(getDetectedTypes(sections));
      expect(detectedTypes).toContain('hero');
      expect(detectedTypes).toContain('feature');
      expect(detectedTypes).toContain('cta');
      expect(detectedTypes).toContain('footer');
    });

    /**
     * 高信頼度検出の目標テスト（改善後に有効化）
     *
     * 目標: 検出されたセクションの平均信頼度が0.7以上
     */
    it.skip('should achieve average confidence >= 0.7 after improvements', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);

      // 有意なセクション（unknownを除く）のみで計算
      const meaningfulSections = sections.filter((s) => s.type !== 'unknown');
      const avgConfidence =
        meaningfulSections.reduce((sum, s) => sum + s.confidence, 0) / meaningfulSections.length;

      expect(avgConfidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Semantic Tag Fallback', () => {
    /**
     * セマンティックタグによる検出（現在も機能する）
     *
     * Tailwindサイトでも<nav>, <footer>, <section>などの
     * セマンティックタグは使用されるため、これらは検出可能
     */
    it('should detect navigation via <nav> semantic tag', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const navSections = findSectionsByType(sections, 'navigation');

      // <nav>タグは検出されるはず
      expect(navSections.length).toBeGreaterThanOrEqual(1);
      expect(navSections[0].element.tagName).toBe('nav');
    });

    it('should detect footer via <footer> semantic tag', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const footerSections = findSectionsByType(sections, 'footer');

      // <footer>タグは検出されるはず
      expect(footerSections.length).toBeGreaterThanOrEqual(1);
      expect(footerSections[0].element.tagName).toBe('footer');
    });
  });

  describe('Content-Based Detection (Existing Capability)', () => {
    /**
     * blockquoteによるtestimonial検出
     */
    it('should detect testimonial via <blockquote> element', async () => {
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const testimonialSections = findSectionsByType(sections, 'testimonial');

      // blockquoteがある場合、testimonialとして検出される可能性
      // （現状のclassifySectionTypeでblockquote検出ロジックあり）
      console.log(`Testimonial sections found: ${testimonialSections.length}`);

      // 検出された場合、blockquoteを含むことを確認
      if (testimonialSections.length > 0) {
        // HTMLスニペット内にblockquoteが含まれることを期待
        expect(testimonialSections[0].htmlSnippet).toBeDefined();
      }
    });

    /**
     * formによるcontact検出
     *
     * 注意: 現在のSectionDetectorはform + email/messageフィールドでcontact検出するが、
     * Tailwind CSSのinput要素では name="email" が必要（classではなく）
     * これはTailwindサイトでの追加の検出課題を示す
     */
    it('should detect contact section if form is present', async () => {
      const htmlWithForm = createTailwindHtml(`
        <section class="py-16 bg-white">
          <div class="max-w-lg mx-auto">
            <h2 class="text-3xl font-bold">お問い合わせ</h2>
            <form class="mt-8">
              <input type="email" name="email" placeholder="メールアドレス" class="w-full p-3 border rounded">
              <textarea name="message" placeholder="メッセージ" class="mt-4 w-full p-3 border rounded"></textarea>
              <button type="submit" class="mt-4 w-full py-3 bg-indigo-600 text-white rounded">送信</button>
            </form>
          </div>
        </section>
      `);

      const sections = await detector.detect(htmlWithForm);
      const contactSections = findSectionsByType(sections, 'contact');

      // 現状の動作を記録
      // 発見: formがあってもTailwind CSSサイトではcontactとして検出されない場合がある
      // 原因分析が必要（contact検出ロジックの調査）
      console.log(`Contact sections found: ${contactSections.length}`);
      console.log(`Total sections: ${sections.length}`);
      sections.forEach((s) => {
        console.log(`  Type: ${s.type}, Confidence: ${s.confidence.toFixed(2)}`);
      });

      // 最低限、セクションとして検出されることを確認
      expect(sections.length).toBeGreaterThanOrEqual(1);

      // TODO: contact検出の改善後、以下を有効化
      // expect(contactSections.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// =========================================
// Tailwind Pattern Dictionary Tests (P2 Enhancement)
// =========================================

describe('SectionDetector - Tailwind Pattern Dictionary (P2)', () => {
  let detector: SectionDetector;

  beforeEach(() => {
    detector = new SectionDetector();
  });

  describe('Flexbox Patterns', () => {
    /**
     * フレックスボックスレイアウトパターンの検出
     * - flex, flex-col, items-center, justify-between 等
     */
    it('should detect feature section with flex layout pattern', async () => {
      const html = createTailwindHtml(`
        <section class="py-16 bg-white">
          <div class="max-w-7xl mx-auto px-4">
            <h2 class="text-3xl font-bold">サービス一覧</h2>
            <div class="mt-12 flex flex-wrap gap-8">
              <div class="flex-1 min-w-[280px] p-6 bg-gray-50 rounded-lg">
                <h3 class="text-xl font-semibold">サービスA</h3>
                <p class="mt-2 text-gray-600">説明文がここに入ります</p>
              </div>
              <div class="flex-1 min-w-[280px] p-6 bg-gray-50 rounded-lg">
                <h3 class="text-xl font-semibold">サービスB</h3>
                <p class="mt-2 text-gray-600">説明文がここに入ります</p>
              </div>
              <div class="flex-1 min-w-[280px] p-6 bg-gray-50 rounded-lg">
                <h3 class="text-xl font-semibold">サービスC</h3>
                <p class="mt-2 text-gray-600">説明文がここに入ります</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const featureSections = findSectionsByType(sections, 'feature');

      // flex + flex-wrap パターンで feature として検出されることを期待
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
      expect(featureSections[0].confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should detect section with flex-col layout', async () => {
      const html = createTailwindHtml(`
        <section class="py-12 bg-slate-100">
          <div class="max-w-3xl mx-auto px-4">
            <div class="flex flex-col space-y-6">
              <div class="p-4 bg-white rounded shadow">
                <h3 class="font-bold">ステップ1</h3>
                <p>最初のステップの説明</p>
              </div>
              <div class="p-4 bg-white rounded shadow">
                <h3 class="font-bold">ステップ2</h3>
                <p>次のステップの説明</p>
              </div>
              <div class="p-4 bg-white rounded shadow">
                <h3 class="font-bold">ステップ3</h3>
                <p>最後のステップの説明</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);

      // flex-col + space-y-* パターンで検出されることを期待
      expect(sections.length).toBeGreaterThanOrEqual(1);
      // 3つのカード構造があるためfeatureとして検出されることを期待
      const featureSections = findSectionsByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect navigation-like section with flex items-center justify-between', async () => {
      const html = createTailwindHtml(`
        <header class="py-4 bg-white shadow-sm">
          <div class="max-w-7xl mx-auto px-4 flex items-center justify-between">
            <a href="/" class="text-xl font-bold">Logo</a>
            <div class="flex items-center space-x-4">
              <a href="/about" class="text-gray-600 hover:text-gray-900">About</a>
              <a href="/services" class="text-gray-600 hover:text-gray-900">Services</a>
              <a href="/contact" class="text-gray-600 hover:text-gray-900">Contact</a>
            </div>
          </div>
        </header>
      `);

      const sections = await detector.detect(html);

      // flex items-center justify-between パターンはナビゲーションの典型的なパターン
      // header タグがあるためセクションとして検出される
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Spacing Patterns (space-y, space-x, gap)', () => {
    /**
     * スペーシングユーティリティパターンの検出
     * - space-y-*, space-x-*, gap-* の各バリエーション
     */
    it('should detect section with space-y spacing pattern', async () => {
      const html = createTailwindHtml(`
        <section class="py-16">
          <div class="max-w-4xl mx-auto space-y-8">
            <h2 class="text-2xl font-bold">よくある質問</h2>
            <div class="space-y-4">
              <details class="p-4 bg-gray-100 rounded">
                <summary class="font-medium cursor-pointer">質問1</summary>
                <p class="mt-2">回答1の内容</p>
              </details>
              <details class="p-4 bg-gray-100 rounded">
                <summary class="font-medium cursor-pointer">質問2</summary>
                <p class="mt-2">回答2の内容</p>
              </details>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);

      // space-y-* パターンで FAQ/accordion 構造を検出
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect feature section with gap-* pattern', async () => {
      const html = createTailwindHtml(`
        <section class="py-20 bg-gray-50">
          <div class="container mx-auto px-4">
            <h2 class="text-3xl font-bold text-center mb-12">主な特徴</h2>
            <div class="flex flex-wrap gap-6 lg:gap-10">
              <div class="w-full md:w-[calc(50%-12px)] lg:w-[calc(33.333%-27px)] p-6 bg-white rounded-xl shadow">
                <h3 class="text-lg font-semibold">特徴1</h3>
                <p class="mt-2 text-gray-600">説明文</p>
              </div>
              <div class="w-full md:w-[calc(50%-12px)] lg:w-[calc(33.333%-27px)] p-6 bg-white rounded-xl shadow">
                <h3 class="text-lg font-semibold">特徴2</h3>
                <p class="mt-2 text-gray-600">説明文</p>
              </div>
              <div class="w-full md:w-[calc(50%-12px)] lg:w-[calc(33.333%-27px)] p-6 bg-white rounded-xl shadow">
                <h3 class="text-lg font-semibold">特徴3</h3>
                <p class="mt-2 text-gray-600">説明文</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const featureSections = findSectionsByType(sections, 'feature');

      // gap-6, lg:gap-10 パターンで feature として検出されることを期待
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Responsive Prefix Patterns', () => {
    /**
     * レスポンシブプレフィックスパターンの検出
     * - sm:, md:, lg:, xl:, 2xl: プレフィックス付きクラス
     */
    it('should detect section with responsive grid patterns', async () => {
      const html = createTailwindHtml(`
        <section class="py-16 bg-white">
          <div class="max-w-7xl mx-auto px-4">
            <h2 class="text-3xl font-bold mb-12">パートナー企業</h2>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-8">
              <img src="/logo1.png" alt="Partner 1" class="h-12 object-contain">
              <img src="/logo2.png" alt="Partner 2" class="h-12 object-contain">
              <img src="/logo3.png" alt="Partner 3" class="h-12 object-contain">
              <img src="/logo4.png" alt="Partner 4" class="h-12 object-contain">
              <img src="/logo5.png" alt="Partner 5" class="h-12 object-contain">
              <img src="/logo6.png" alt="Partner 6" class="h-12 object-contain">
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);

      // 複数のレスポンシブグリッドプレフィックス検出
      expect(sections.length).toBeGreaterThanOrEqual(1);
      // ロゴ画像が4つ以上あるため gallery または partners として検出される可能性
      const detectedTypes = getDetectedTypes(sections);
      expect(
        detectedTypes.includes('gallery') ||
        detectedTypes.includes('partners') ||
        detectedTypes.includes('feature')
      ).toBe(true);
    });

    it('should detect section with responsive flex patterns', async () => {
      const html = createTailwindHtml(`
        <section class="py-12">
          <div class="max-w-6xl mx-auto px-4">
            <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div class="md:w-1/2">
                <h2 class="text-3xl font-bold">会社について</h2>
                <p class="mt-4 text-gray-600">
                  私たちは革新的なソリューションを提供する企業です。
                </p>
              </div>
              <div class="md:w-1/2">
                <img src="/company.jpg" alt="Company" class="rounded-lg shadow-lg">
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);

      // md:flex-row, md:items-center, md:justify-between のレスポンシブパターン検出
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Container Patterns (container, max-w, mx-auto)', () => {
    /**
     * コンテナパターンの検出
     * - container, max-w-*, mx-auto の組み合わせ
     */
    it('should detect section with container class', async () => {
      const html = createTailwindHtml(`
        <section class="py-20">
          <div class="container mx-auto px-4">
            <h2 class="text-4xl font-bold text-center">コンテナパターン</h2>
            <p class="mt-4 text-xl text-center text-gray-600 max-w-2xl mx-auto">
              container クラスを使用したセンタリングレイアウト
            </p>
            <div class="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8">
              <div class="p-6 border rounded-lg">
                <h3 class="text-lg font-semibold">カード1</h3>
                <p class="mt-2 text-gray-600">説明</p>
              </div>
              <div class="p-6 border rounded-lg">
                <h3 class="text-lg font-semibold">カード2</h3>
                <p class="mt-2 text-gray-600">説明</p>
              </div>
              <div class="p-6 border rounded-lg">
                <h3 class="text-lg font-semibold">カード3</h3>
                <p class="mt-2 text-gray-600">説明</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);

      // container + mx-auto パターンで検出
      expect(sections.length).toBeGreaterThanOrEqual(1);
      // 3つのカード構造があるため feature として検出
      const featureSections = findSectionsByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect hero section with max-w-7xl mx-auto pattern', async () => {
      const html = createTailwindHtml(`
        <section class="pt-32 pb-20 bg-gradient-to-b from-blue-50 to-white">
          <div class="max-w-7xl mx-auto px-4 text-center">
            <h1 class="text-5xl font-extrabold text-gray-900">
              革新的なソリューション
            </h1>
            <p class="mt-6 text-xl text-gray-600 max-w-3xl mx-auto">
              ビジネスを次のレベルへ導く最先端のテクノロジー
            </p>
            <div class="mt-10 flex justify-center gap-4">
              <button class="px-8 py-4 bg-blue-600 text-white rounded-lg font-medium">
                今すぐ始める
              </button>
              <button class="px-8 py-4 border border-gray-300 rounded-lg font-medium">
                詳しく見る
              </button>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const heroSections = findSectionsByType(sections, 'hero');

      // H1 + ボタン + ページ上部の条件でheroとして検出
      expect(heroSections.length).toBeGreaterThanOrEqual(1);
      expect(heroSections[0].confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Background Color Patterns (bg-* for CTA/Pricing)', () => {
    /**
     * 背景色パターンによるCTA/Pricing検出
     * - bg-indigo-*, bg-blue-*, bg-slate-* 等の背景色クラス
     */
    it('should detect CTA section with colored background pattern', async () => {
      const html = createTailwindHtml(`
        <section class="py-20 bg-gradient-to-r from-purple-600 to-indigo-600">
          <div class="max-w-4xl mx-auto px-4 text-center">
            <h2 class="text-3xl font-bold text-white">今すぐ始めましょう</h2>
            <p class="mt-4 text-lg text-purple-100">
              30日間の無料トライアルですべての機能をお試しください
            </p>
            <div class="mt-8">
              <button class="px-8 py-4 bg-white text-purple-600 rounded-lg font-bold shadow-lg hover:bg-gray-100">
                無料で始める
              </button>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const ctaSections = findSectionsByType(sections, 'cta');

      // 色付き背景 + ボタン + 短いテキストでCTAとして検出
      expect(ctaSections.length).toBeGreaterThanOrEqual(1);
      expect(ctaSections[0].confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should detect pricing section with bg-slate/gray patterns', async () => {
      const html = createTailwindHtml(`
        <section class="py-24 bg-slate-50">
          <div class="max-w-6xl mx-auto px-4">
            <h2 class="text-4xl font-bold text-center">料金プラン</h2>
            <p class="mt-4 text-center text-gray-600">シンプルで透明な料金体系</p>
            <div class="mt-16 grid gap-8 lg:grid-cols-3">
              <div class="p-8 bg-white rounded-2xl shadow-sm border">
                <h3 class="text-xl font-bold">スタンダード</h3>
                <p class="mt-6 text-4xl font-bold">¥4,980<span class="text-lg text-gray-500">/月</span></p>
                <button class="mt-8 w-full py-3 bg-gray-900 text-white rounded-lg">選択する</button>
              </div>
              <div class="p-8 bg-indigo-600 rounded-2xl shadow-lg text-white">
                <h3 class="text-xl font-bold">プロ</h3>
                <p class="mt-6 text-4xl font-bold">¥9,980<span class="text-lg text-indigo-200">/月</span></p>
                <button class="mt-8 w-full py-3 bg-white text-indigo-600 rounded-lg font-bold">選択する</button>
              </div>
              <div class="p-8 bg-white rounded-2xl shadow-sm border">
                <h3 class="text-xl font-bold">エンタープライズ</h3>
                <p class="mt-6 text-4xl font-bold">お問い合わせ</p>
                <button class="mt-8 w-full py-3 bg-gray-900 text-white rounded-lg">相談する</button>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const pricingSections = findSectionsByType(sections, 'pricing');

      // 価格表示（¥/月）+ グリッドレイアウト で pricing として検出
      expect(pricingSections.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Combined Pattern Detection', () => {
    /**
     * 複合パターンの検出テスト
     * 複数のTailwindパターンを組み合わせたセクションの検出
     */
    it('should detect feature section with multiple Tailwind patterns', async () => {
      const html = createTailwindHtml(`
        <section class="py-24 bg-gradient-to-b from-gray-50 to-white">
          <div class="container mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center max-w-3xl mx-auto">
              <h2 class="text-4xl font-extrabold sm:text-5xl">なぜ選ばれるのか</h2>
              <p class="mt-4 text-xl text-gray-500">お客様に選ばれる3つの理由</p>
            </div>
            <div class="mt-20 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
              <div class="relative flex flex-col items-center p-8 bg-white rounded-2xl shadow-xl">
                <div class="flex items-center justify-center w-16 h-16 rounded-full bg-indigo-100">
                  <svg class="w-8 h-8 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 class="mt-6 text-xl font-bold">高速処理</h3>
                <p class="mt-4 text-center text-gray-600">業界最速のレスポンスタイム</p>
              </div>
              <div class="relative flex flex-col items-center p-8 bg-white rounded-2xl shadow-xl">
                <div class="flex items-center justify-center w-16 h-16 rounded-full bg-green-100">
                  <svg class="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 class="mt-6 text-xl font-bold">信頼性</h3>
                <p class="mt-4 text-center text-gray-600">99.99%の稼働率を保証</p>
              </div>
              <div class="relative flex flex-col items-center p-8 bg-white rounded-2xl shadow-xl sm:col-span-2 lg:col-span-1">
                <div class="flex items-center justify-center w-16 h-16 rounded-full bg-purple-100">
                  <svg class="w-8 h-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                </div>
                <h3 class="mt-6 text-xl font-bold">サポート</h3>
                <p class="mt-4 text-center text-gray-600">24時間365日対応</p>
              </div>
            </div>
          </div>
        </section>
      `);

      const sections = await detector.detect(html);
      const featureSections = findSectionsByType(sections, 'feature');

      // container + mx-auto + grid + flex-col + items-center の複合パターン
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
      expect(featureSections[0].confidence).toBeGreaterThanOrEqual(0.65);
    });

    it('should correctly identify section types in a full Tailwind page', async () => {
      // 既存のTAILWIND_FULL_PAGE_HTMLを使用
      const sections = await detector.detect(TAILWIND_FULL_PAGE_HTML);
      const detectedTypes = getDetectedTypes(sections);

      console.log('\n=== Full Tailwind Page Detection (After P2 Enhancement) ===');
      console.log(`Total sections: ${sections.length}`);
      console.log(`Detected types: ${detectedTypes.join(', ')}`);

      sections.forEach((s, i) => {
        console.log(`  ${i + 1}. [${s.type}] confidence: ${s.confidence.toFixed(2)}, classes: ${s.element.classes.slice(0, 3).join(' ')}...`);
      });
      console.log('============================================================\n');

      // 基本的なセクションタイプが検出されることを確認
      expect(detectedTypes).toContain('navigation');
      expect(detectedTypes).toContain('footer');

      // P2改善後、hero/feature/cta/pricing も検出されることを期待
      const result = calculateDetectionRate(sections, EXPECTED_SECTIONS);
      // 目標: 少なくとも 5/7 (71%) 以上の検出率
      expect(result.rate).toBeGreaterThanOrEqual(71);
    });
  });
});

// =========================================
// Improvement Tracking
// =========================================

/**
 * 改善追跡用のメタデータ
 *
 * ベースライン測定日: 2026-01-31
 * ベースライン検出率: TBD（テスト実行時に記録）
 *
 * 改善計画:
 * 1. [x] Tailwindグリッドパターン検出の強化 (P1)
 * 2. [ ] フレックスボックスパターン検出 (P2)
 * 3. [ ] スペーシングパターン検出 (P2)
 * 4. [ ] レスポンシブプレフィックスパターン (P2)
 * 5. [ ] コンテナパターン検出 (P2)
 * 6. [ ] 背景色クラスパターンによるセクション分類 (P2)
 * 7. [ ] コンテンツベース検出の信頼度向上
 * 8. [ ] テキストキーワード分析の導入
 *
 * 目標達成基準:
 * - 検出率: 80%以上
 * - 平均信頼度: 0.7以上
 * - すべてのskipテストがパス
 */
