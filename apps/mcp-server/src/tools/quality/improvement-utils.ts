// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 品質改善提案ユーティリティ
 *
 * quality.evaluateのaction: "suggest_improvements"で使用される
 * 改善提案生成ロジックを提供します。
 *
 * @module tools/quality/improvement-utils
 */

import {
  type Improvement,
  type ImprovementSummary,
  type ImprovementCategory,
  type RecommendationPriority,
  type QualityEvaluateData,
} from './schemas';

// =====================================================
// 定数
// =====================================================

/**
 * 代替グラデーションカラー（AI典型を回避）
 */
const ALTERNATIVE_GRADIENTS = [
  { from: '#3B82F6', to: '#8B5CF6', name: 'Blue to Purple' },
  { from: '#10B981', to: '#3B82F6', name: 'Green to Blue' },
  { from: '#F59E0B', to: '#EF4444', name: 'Amber to Red' },
  { from: '#6366F1', to: '#EC4899', name: 'Indigo to Pink' },
  { from: '#14B8A6', to: '#8B5CF6', name: 'Teal to Purple' },
];

/**
 * AI典型フレーズの代替
 */
const TEXT_ALTERNATIVES: Record<string, string[]> = {
  'transform your business': [
    'Streamline your workflow',
    'Elevate your operations',
    'Modernize your approach',
  ],
  'unlock the power': [
    'Discover the potential',
    'Harness the capability',
    'Leverage the strength',
  ],
  'cutting-edge solutions': [
    'Practical solutions',
    'Effective tools',
    'Modern approaches',
  ],
  'seamless integration': [
    'Easy setup',
    'Quick connection',
    'Smooth workflow',
  ],
  'get started today': [
    'Begin now',
    'Start your journey',
    'Try it free',
  ],
  'scale effortlessly': [
    'Grow with confidence',
    'Expand smoothly',
    'Scale as you need',
  ],
};

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * グラデーションクリシェの改善を生成
 */
function generateGradientImprovement(
  html: string,
  pattern: { description: string; severity: string }
): Improvement | null {
  // AI典型グラデーションを検出
  const gradientMatch = html.match(
    /(?:background(?:-image)?:\s*)?linear-gradient\s*\([^)]*(?:#667eea|#764ba2|#f857a6|#ff5858)[^)]*\)/i
  );

  if (!gradientMatch) return null;

  const alternative = ALTERNATIVE_GRADIENTS[Math.floor(Math.random() * ALTERNATIVE_GRADIENTS.length)];
  if (!alternative) return null;

  return {
    id: `imp-gradient-${Date.now()}`,
    category: 'originality',
    priority: pattern.severity as RecommendationPriority,
    title: 'グラデーションカラーを変更',
    description: `${pattern.description}を独自カラーに変更します。`,
    originalCode: gradientMatch[0],
    suggestedCode: `background: linear-gradient(to right, ${alternative.from}, ${alternative.to}); /* ${alternative.name} */`,
    impact: pattern.severity === 'high' ? 15 : 10,
  };
}

/**
 * テキストクリシェの改善を生成
 */
function generateTextImprovement(
  html: string,
  pattern: { description: string; severity: string }
): Improvement | null {
  // パターンからフレーズを抽出
  const phraseMatch = pattern.description.match(/"([^"]+)"/);
  const phraseOriginal = phraseMatch?.[1];
  if (!phraseOriginal) return null;

  const phrase = phraseOriginal.toLowerCase();
  const alternatives = TEXT_ALTERNATIVES[phrase];

  if (!alternatives || alternatives.length === 0) return null;

  // HTMLからフレーズを検索
  const regex = new RegExp(phrase.replace(/\s+/g, '\\s+'), 'i');
  const match = html.match(regex);

  if (!match) return null;

  const alternative = alternatives[Math.floor(Math.random() * alternatives.length)];
  if (!alternative) return null;

  return {
    id: `imp-text-${Date.now()}`,
    category: 'originality',
    priority: pattern.severity as RecommendationPriority,
    title: 'AI典型フレーズを変更',
    description: `"${phraseOriginal}"をより独自性のある表現に変更します。`,
    originalCode: match[0],
    suggestedCode: alternative,
    impact: pattern.severity === 'high' ? 12 : 8,
  };
}

/**
 * アクセシビリティ改善を生成（alt属性）
 */
function generateAltImprovement(html: string): Improvement | null {
  // alt属性のない画像を検出
  const imgWithoutAlt = html.match(/<img(?![^>]*alt=)[^>]*>/i);

  if (!imgWithoutAlt) return null;

  // src属性を取得してファイル名を推測
  const srcMatch = imgWithoutAlt[0].match(/src="([^"]+)"/i);
  const srcValue = srcMatch?.[1];
  const baseFilename = srcValue?.split('/').pop()?.replace(/\.[^.]+$/, '');
  const filename = baseFilename && baseFilename.length > 0 ? baseFilename : 'image';
  const altText = filename.replace(/[-_]/g, ' ') || 'Descriptive text here';

  return {
    id: `imp-alt-${Date.now()}`,
    category: 'accessibility',
    priority: 'high',
    title: '画像にalt属性を追加',
    description: 'スクリーンリーダー用に代替テキストを追加します。',
    originalCode: imgWithoutAlt[0],
    suggestedCode: imgWithoutAlt[0].replace(/<img/, `<img alt="${altText}"`),
    impact: 10,
  };
}

/**
 * セマンティックHTML改善を生成
 */
function generateSemanticImprovement(html: string): Improvement | null {
  // div.header, div.main, div.footer などを検出
  const headerDiv = html.match(/<div[^>]*class="[^"]*header[^"]*"[^>]*>/i);
  const mainDiv = html.match(/<div[^>]*class="[^"]*(?:main|content)[^"]*"[^>]*>/i);
  const footerDiv = html.match(/<div[^>]*class="[^"]*footer[^"]*"[^>]*>/i);

  if (!headerDiv && !mainDiv && !footerDiv) return null;

  const improvements: string[] = [];
  let originalCode = '';
  let suggestedCode = '';

  if (headerDiv) {
    originalCode = headerDiv[0];
    suggestedCode = headerDiv[0]
      .replace(/<div/, '<header')
      .replace(/class="([^"]*)"/, 'class="$1" role="banner"');
    improvements.push('headerタグに変更');
  } else if (mainDiv) {
    originalCode = mainDiv[0];
    suggestedCode = mainDiv[0]
      .replace(/<div/, '<main')
      .replace(/class="([^"]*)"/, 'class="$1" role="main"');
    improvements.push('mainタグに変更');
  } else if (footerDiv) {
    originalCode = footerDiv[0];
    suggestedCode = footerDiv[0]
      .replace(/<div/, '<footer')
      .replace(/class="([^"]*)"/, 'class="$1" role="contentinfo"');
    improvements.push('footerタグに変更');
  }

  return {
    id: `imp-semantic-${Date.now()}`,
    category: 'craftsmanship',
    priority: 'medium',
    title: 'セマンティックHTMLに変換',
    description: `divタグを適切なセマンティックタグに変換します（${improvements.join(', ')}）。`,
    originalCode,
    suggestedCode,
    impact: 8,
  };
}

/**
 * インラインイベントハンドラの改善を生成
 */
function generateEventHandlerImprovement(html: string): Improvement | null {
  const onclickMatch = html.match(/<[^>]+onclick="([^"]+)"[^>]*>/i);

  if (!onclickMatch) return null;

  const elementMatch = onclickMatch[0].match(/<(\w+)/);
  const elementType = elementMatch ? elementMatch[1] : 'element';
  const handler = onclickMatch[1];

  return {
    id: `imp-event-${Date.now()}`,
    category: 'craftsmanship',
    priority: 'medium',
    title: 'インラインイベントハンドラを削除',
    description: 'onclick属性の代わりにaddEventListenerを使用します。',
    originalCode: onclickMatch[0],
    suggestedCode: `<!-- HTMLから削除 -->
<${elementType} id="myElement">...</${elementType}>

<!-- JavaScriptで追加 -->
<script>
  document.getElementById('myElement').addEventListener('click', () => {
    ${handler}
  });
</script>`,
    impact: 6,
  };
}

/**
 * ピル型ボタンの改善を生成
 */
function generateButtonStyleImprovement(html: string): Improvement | null {
  const pillButtonMatch = html.match(/border-radius:\s*9999px/i);

  if (!pillButtonMatch) return null;

  return {
    id: `imp-button-${Date.now()}`,
    category: 'originality',
    priority: 'low',
    title: 'ボタンスタイルを調整',
    description: 'AI典型のピル型ボタンからより特徴的なスタイルに変更します。',
    originalCode: 'border-radius: 9999px;',
    suggestedCode: `border-radius: 8px; /* またはブランドに合わせたカスタム値 */
/* 例: border-radius: 0; で角ばったスタイル */
/* 例: border-radius: 4px 12px; で非対称スタイル */`,
    impact: 5,
  };
}

// =====================================================
// パブリック関数
// =====================================================

/**
 * 評価結果から改善提案を生成
 * @public quality.evaluate の action: "suggest_improvements" から使用
 */
export function generateImprovements(
  evaluation: QualityEvaluateData,
  html: string,
  options: {
    categories?: ImprovementCategory[] | undefined;
    minPriority?: RecommendationPriority | undefined;
    maxSuggestions: number;
  }
): Improvement[] {
  const improvements: Improvement[] = [];

  // クリシェパターンから改善を生成
  if (evaluation.clicheDetection?.patterns) {
    for (const pattern of evaluation.clicheDetection.patterns) {
      if (pattern.type === 'gradient') {
        const imp = generateGradientImprovement(html, pattern);
        if (imp) improvements.push(imp);
      } else if (pattern.type === 'text') {
        const imp = generateTextImprovement(html, pattern);
        if (imp) improvements.push(imp);
      } else if (pattern.type === 'button') {
        const imp = generateButtonStyleImprovement(html);
        if (imp) improvements.push(imp);
      }
    }
  }

  // アクセシビリティ改善
  const altImp = generateAltImprovement(html);
  if (altImp) improvements.push(altImp);

  // セマンティックHTML改善
  const semanticImp = generateSemanticImprovement(html);
  if (semanticImp) improvements.push(semanticImp);

  // イベントハンドラ改善
  const eventImp = generateEventHandlerImprovement(html);
  if (eventImp) improvements.push(eventImp);

  // カテゴリフィルタ
  let filtered = improvements;
  const categories = options.categories;
  if (categories && categories.length > 0) {
    filtered = filtered.filter((imp) => categories.includes(imp.category));
  }

  // 優先度フィルタ
  if (options.minPriority) {
    const priorityOrder: Record<RecommendationPriority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    const minPriorityLevel = priorityOrder[options.minPriority];
    filtered = filtered.filter(
      (imp) => priorityOrder[imp.priority] <= minPriorityLevel
    );
  }

  // 優先度でソート
  const priorityOrder: Record<RecommendationPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  filtered.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // 最大数に制限
  return filtered.slice(0, options.maxSuggestions);
}

/**
 * サマリーを計算
 * @public quality.evaluate の action: "suggest_improvements" から使用
 */
export function calculateSummary(improvements: Improvement[]): ImprovementSummary {
  const categoryCounts: ImprovementSummary['categoryCounts'] = {
    originality: 0,
    craftsmanship: 0,
    contextuality: 0,
    accessibility: 0,
    performance: 0,
    general: 0,
  };

  let totalImpact = 0;

  for (const imp of improvements) {
    if (categoryCounts[imp.category] !== undefined) {
      categoryCounts[imp.category]!++;
    }
    totalImpact += imp.impact ?? 0;
  }

  return {
    totalImprovements: improvements.length,
    estimatedScoreGain: Math.min(totalImpact, 100),
    categoryCounts,
  };
}
