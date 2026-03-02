// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * アクショナブル警告メッセージ ユーティリティ
 *
 * 警告メッセージを構造化し、開発者が具体的なアクションを取れるようにする。
 *
 * 警告メッセージの構造:
 * - type: 警告タイプ（常に 'warning'）
 * - code: 警告コード（一意の識別子）
 * - severity: 重大度（info/warning/error）
 * - message: 何が問題か
 * - impact: なぜ問題か（影響）
 * - action: どう対処すべきか（推奨アクション）
 * - docs: ドキュメントやリソースへのリンク（オプション）
 * - context: 追加の詳細情報（オプション）
 *
 * @module @reftrix/mcp-server/utils/actionable-warning
 */

// =============================================================================
// 型定義
// =============================================================================

/** 警告の重大度 */
export type WarningSeverity = 'info' | 'warning' | 'error';

/** 警告コード型 */
export type ActionableWarningCode = keyof typeof WARNING_CODES;

/** アクショナブル警告インターフェース */
export interface ActionableWarning {
  /** 警告タイプ（常に 'warning'） */
  type: 'warning';
  /** 警告コード */
  code: string;
  /** 重大度 */
  severity: WarningSeverity;
  /** 問題の説明（何が問題か） */
  message: string;
  /** 影響の説明（なぜ問題か） */
  impact: string;
  /** 推奨アクション（どう対処すべきか） */
  action: string;
  /** ドキュメントへのリンク（オプション） */
  docs?: string;
  /** 追加のコンテキスト情報（オプション） */
  context?: Record<string, unknown>;
}

/** 旧形式の警告（後方互換性用） */
export interface LegacyWarning {
  feature: 'layout' | 'motion' | 'quality' | 'responsive';
  code: string;
  message: string;
}

/** フォーマットオプション */
export interface FormatOptions {
  /** 出力形式 */
  format?: 'text' | 'json' | 'compact';
  /** 区切り文字（複数警告時） */
  separator?: string;
}

// =============================================================================
// 定数
// =============================================================================

/** 警告コード定数 */
export const WARNING_CODES = {
  // Page-level errors (v0.1.0)
  PAGE_TIMEOUT: 'PAGE_TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  BROWSER_ERROR: 'BROWSER_ERROR',

  // Layout related
  LAYOUT_TIMEOUT: 'LAYOUT_TIMEOUT',
  LAYOUT_PARTIAL: 'LAYOUT_PARTIAL',
  CSS_FRAMEWORK_UNKNOWN: 'CSS_FRAMEWORK_UNKNOWN',
  NO_SECTIONS_DETECTED: 'NO_SECTIONS_DETECTED',

  // Motion related
  MOTION_TIMEOUT: 'MOTION_TIMEOUT',
  MOTION_DETECTION_PARTIAL: 'MOTION_DETECTION_PARTIAL',
  JS_ANIMATION_SKIPPED: 'JS_ANIMATION_SKIPPED',
  WEBGL_ANIMATION_SKIPPED: 'WEBGL_ANIMATION_SKIPPED',
  FRAME_CAPTURE_FAILED: 'FRAME_CAPTURE_FAILED',
  NO_ANIMATIONS_DETECTED: 'NO_ANIMATIONS_DETECTED',

  // Quality related
  QUALITY_TIMEOUT: 'QUALITY_TIMEOUT',
  QUALITY_EVALUATION_PARTIAL: 'QUALITY_EVALUATION_PARTIAL',
  LOW_QUALITY_SCORE: 'LOW_QUALITY_SCORE',

  // Vision related
  VISION_AI_UNAVAILABLE: 'VISION_AI_UNAVAILABLE',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  VISION_ANALYSIS_FAILED: 'VISION_ANALYSIS_FAILED',
  MOOD_FALLBACK_USED: 'MOOD_FALLBACK_USED',
  BRAND_TONE_FALLBACK_USED: 'BRAND_TONE_FALLBACK_USED',

  // Network/Browser related
  NETWORK_SLOW: 'NETWORK_SLOW',
  BROWSER_RESOURCE_LIMIT: 'BROWSER_RESOURCE_LIMIT',
  EXTERNAL_CSS_FETCH_FAILED: 'EXTERNAL_CSS_FETCH_FAILED',

  // Performance related
  RESPONSE_SIZE_LARGE: 'RESPONSE_SIZE_LARGE',
  PROCESSING_TIME_EXCEEDED: 'PROCESSING_TIME_EXCEEDED',

  // Generic
  UNKNOWN: 'UNKNOWN',
} as const;

/** 重大度レベル定数 */
export const WARNING_SEVERITY = {
  INFO: 'info' as const,
  WARNING: 'warning' as const,
  ERROR: 'error' as const,
};

/** ドキュメントベースURL */
const DOCS_BASE_URL = 'https://reftrix.dev/docs';

// =============================================================================
// ロケール管理
// =============================================================================

type Locale = 'en' | 'ja';
let currentLocale: Locale = 'en';

/** ロケールを設定 */
export function setWarningLocale(locale: Locale): void {
  currentLocale = locale;
}

/** 現在のロケールを取得 */
export function getWarningLocale(): Locale {
  return currentLocale;
}

// =============================================================================
// 警告メッセージテンプレート
// =============================================================================

interface WarningTemplate {
  severity: WarningSeverity;
  message: { en: string; ja: string };
  impact: { en: string; ja: string };
  action: { en: string; ja: string };
  docs: string;
}

const WARNING_TEMPLATES: Record<string, WarningTemplate> = {
  LAYOUT_TIMEOUT: {
    severity: 'warning',
    message: {
      en: 'Layout analysis timed out after {actualTimeMs}ms (configured: {configuredTimeoutMs}ms)',
      ja: 'レイアウト分析が{actualTimeMs}ms後にタイムアウトしました（設定: {configuredTimeoutMs}ms）',
    },
    impact: {
      en: 'Section detection may be incomplete. Some sections might not be identified.',
      ja: 'セクション検出が不完全な可能性があります。一部のセクションが検出されない場合があります。',
    },
    action: {
      en: 'Increase layoutTimeout parameter or check if the URL loads slowly. Consider using summary=true to reduce processing.',
      ja: 'layoutTimeoutパラメータを延長するか、URLの読み込み速度を確認してください。summary=trueで処理を軽減できます。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#layout-timeout`,
  },

  MOTION_TIMEOUT: {
    severity: 'warning',
    message: {
      en: 'Motion detection timed out after {actualTimeMs}ms (configured: {configuredTimeoutMs}ms)',
      ja: 'モーション検出が{actualTimeMs}ms後にタイムアウトしました（設定: {configuredTimeoutMs}ms）',
    },
    impact: {
      en: 'Animation patterns may be incomplete. JS/WebGL animations might not be fully detected.',
      ja: 'アニメーションパターンが不完全な可能性があります。JS/WebGLアニメーションが完全に検出されない場合があります。',
    },
    action: {
      en: 'Increase motionTimeout parameter. For WebGL-heavy sites, consider setting timeout to 180000ms or higher.',
      ja: 'motionTimeoutパラメータを延長してください。WebGLが多いサイトでは180000ms以上を推奨します。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#motion-timeout`,
  },

  QUALITY_TIMEOUT: {
    severity: 'warning',
    message: {
      en: 'Quality evaluation timed out after {actualTimeMs}ms (configured: {configuredTimeoutMs}ms)',
      ja: '品質評価が{actualTimeMs}ms後にタイムアウトしました（設定: {configuredTimeoutMs}ms）',
    },
    impact: {
      en: 'Quality scores may not reflect full analysis. Some metrics might be missing.',
      ja: '品質スコアが完全な分析を反映していない可能性があります。一部のメトリクスが欠落する場合があります。',
    },
    action: {
      en: 'Increase qualityTimeout parameter or simplify the page for faster analysis.',
      ja: 'qualityTimeoutパラメータを延長するか、ページを簡素化して高速な分析を行ってください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#quality-timeout`,
  },

  VISION_AI_UNAVAILABLE: {
    severity: 'warning',
    message: {
      en: 'Vision AI service ({service}) is unavailable: {reason}',
      ja: 'Vision AIサービス（{service}）が利用できません: {reason}',
    },
    impact: {
      en: 'Visual feature extraction will be skipped. Mood and brand tone analysis unavailable.',
      ja: 'Visual feature抽出がスキップされます。ムードとブランドトーン分析が利用できません。',
    },
    action: {
      en: 'Ensure Ollama service is running: `ollama serve`. Check if llama3.2-vision model is installed.',
      ja: 'Ollamaサービスが起動しているか確認してください: `ollama serve`。llama3.2-visionモデルがインストールされているか確認してください。',
    },
    docs: `${DOCS_BASE_URL}/setup/vision-ai`,
  },

  VISION_ANALYSIS_FAILED: {
    severity: 'warning',
    message: {
      en: 'Vision analysis failed: {reason}',
      ja: 'Vision分析が失敗しました: {reason}',
    },
    impact: {
      en: 'Visual features extracted from HTML only. Some design insights may be limited.',
      ja: 'HTMLからのVisual feature抽出のみとなります。一部のデザインインサイトが制限される場合があります。',
    },
    action: {
      en: 'Check Ollama logs for errors. Ensure sufficient GPU memory is available.',
      ja: 'Ollamaログでエラーを確認してください。十分なGPUメモリが利用可能か確認してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#vision-analysis`,
  },

  JS_ANIMATION_SKIPPED: {
    severity: 'info',
    message: {
      en: 'JavaScript animation detection was skipped: {reason}',
      ja: 'JavaScriptアニメーション検出がスキップされました: {reason}',
    },
    impact: {
      en: 'Only CSS static analysis results are returned. GSAP, Framer Motion, etc. are not detected.',
      ja: 'CSS静的解析の結果のみが返されます。GSAP、Framer Motion等は検出されません。',
    },
    action: {
      en: 'Enable JS animation detection: set detect_js_animations=true in motionOptions.',
      ja: 'JSアニメーション検出を有効にする: motionOptionsでdetect_js_animations=trueを設定してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/motion-detect#js-animations`,
  },

  WEBGL_ANIMATION_SKIPPED: {
    severity: 'info',
    message: {
      en: 'WebGL animation detection was skipped: {reason}',
      ja: 'WebGLアニメーション検出がスキップされました: {reason}',
    },
    impact: {
      en: 'Three.js and other WebGL-based animations are not detected.',
      ja: 'Three.js等のWebGLベースのアニメーションは検出されません。',
    },
    action: {
      en: 'Enable WebGL detection: set detect_webgl_animations=true in motionOptions.',
      ja: 'WebGL検出を有効にする: motionOptionsでdetect_webgl_animations=trueを設定してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/motion-detect#webgl-animations`,
  },

  FRAME_CAPTURE_FAILED: {
    severity: 'warning',
    message: {
      en: 'Frame capture failed: {reason}',
      ja: 'フレームキャプチャが失敗しました: {reason}',
    },
    impact: {
      en: 'Frame-based animation analysis is unavailable. CLS detection may be limited.',
      ja: 'フレームベースのアニメーション分析が利用できません。CLS検出が制限される場合があります。',
    },
    action: {
      en: 'Reduce frame count or increase timeout. Check available disk space.',
      ja: 'フレーム数を減らすか、タイムアウトを延長してください。ディスク容量を確認してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#frame-capture`,
  },

  EXTERNAL_CSS_FETCH_FAILED: {
    severity: 'warning',
    message: {
      en: 'Failed to fetch {failedCount} of {totalCount} external CSS files',
      ja: '{totalCount}件中{failedCount}件の外部CSSファイルの取得に失敗しました',
    },
    impact: {
      en: 'CSS framework detection and animation analysis may be incomplete.',
      ja: 'CSSフレームワーク検出とアニメーション分析が不完全な可能性があります。',
    },
    action: {
      en: 'Check if external CSS URLs are accessible. Some may require authentication.',
      ja: '外部CSSのURLにアクセス可能か確認してください。認証が必要な場合があります。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#external-css`,
  },

  RESPONSE_SIZE_LARGE: {
    severity: 'info',
    message: {
      en: 'Response size ({actualSizeKB}KB) exceeds recommended limit ({recommendedMaxKB}KB)',
      ja: 'レスポンスサイズ（{actualSizeKB}KB）が推奨上限（{recommendedMaxKB}KB）を超えています',
    },
    impact: {
      en: 'Large responses may slow down processing and increase token usage.',
      ja: '大きなレスポンスは処理速度を低下させ、トークン使用量を増加させる可能性があります。',
    },
    action: {
      en: 'Use summary=true to reduce response size. Avoid including HTML/screenshot unless necessary.',
      ja: 'summary=trueを使用してレスポンスサイズを削減してください。必要でない限りHTML/スクリーンショットを含めないでください。',
    },
    docs: `${DOCS_BASE_URL}/best-practices#token-efficiency`,
  },

  MOOD_FALLBACK_USED: {
    severity: 'info',
    message: {
      en: 'Mood analysis used fallback value: {reason}',
      ja: 'ムード分析でフォールバック値が使用されました: {reason}',
    },
    impact: {
      en: 'Mood classification may be less accurate. Default values are used.',
      ja: 'ムード分類の精度が低い可能性があります。デフォルト値が使用されています。',
    },
    action: {
      en: 'Ensure Vision AI service is available for accurate mood detection.',
      ja: '正確なムード検出のためにVision AIサービスが利用可能か確認してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/page-analyze#visual-features`,
  },

  BRAND_TONE_FALLBACK_USED: {
    severity: 'info',
    message: {
      en: 'Brand tone analysis used fallback value: {reason}',
      ja: 'ブランドトーン分析でフォールバック値が使用されました: {reason}',
    },
    impact: {
      en: 'Brand tone classification may be less accurate. Default values are used.',
      ja: 'ブランドトーン分類の精度が低い可能性があります。デフォルト値が使用されています。',
    },
    action: {
      en: 'Ensure Vision AI service is available for accurate brand tone detection.',
      ja: '正確なブランドトーン検出のためにVision AIサービスが利用可能か確認してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/page-analyze#visual-features`,
  },

  LAYOUT_PARTIAL: {
    severity: 'warning',
    message: {
      en: 'Layout analysis returned partial results',
      ja: 'レイアウト分析が部分的な結果を返しました',
    },
    impact: {
      en: 'Some sections may not be detected. Analysis may be incomplete.',
      ja: '一部のセクションが検出されない可能性があります。分析が不完全な場合があります。',
    },
    action: {
      en: 'Check page structure. Ensure main content is loaded before analysis.',
      ja: 'ページ構造を確認してください。分析前にメインコンテンツが読み込まれていることを確認してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#partial-results`,
  },

  CSS_FRAMEWORK_UNKNOWN: {
    severity: 'info',
    message: {
      en: 'Could not detect CSS framework',
      ja: 'CSSフレームワークを検出できませんでした',
    },
    impact: {
      en: 'CSS framework-specific optimizations will not be applied.',
      ja: 'CSSフレームワーク固有の最適化が適用されません。',
    },
    action: {
      en: 'This is normal for custom CSS. No action required.',
      ja: 'カスタムCSSの場合は正常です。対応は不要です。',
    },
    docs: `${DOCS_BASE_URL}/tools/layout-inspect#css-framework`,
  },

  MOTION_DETECTION_PARTIAL: {
    severity: 'warning',
    message: {
      en: 'Motion detection returned partial results',
      ja: 'モーション検出が部分的な結果を返しました',
    },
    impact: {
      en: 'Some animations may not be detected. CSS-only analysis may be used.',
      ja: '一部のアニメーションが検出されない可能性があります。CSSのみの分析が使用される場合があります。',
    },
    action: {
      en: 'Enable detect_js_animations and detect_webgl_animations for comprehensive detection.',
      ja: '包括的な検出のためにdetect_js_animationsとdetect_webgl_animationsを有効にしてください。',
    },
    docs: `${DOCS_BASE_URL}/tools/motion-detect`,
  },

  QUALITY_EVALUATION_PARTIAL: {
    severity: 'warning',
    message: {
      en: 'Quality evaluation returned partial results',
      ja: '品質評価が部分的な結果を返しました',
    },
    impact: {
      en: 'Overall score may not reflect all quality aspects.',
      ja: '総合スコアがすべての品質側面を反映していない可能性があります。',
    },
    action: {
      en: 'Ensure all required data is available for full evaluation.',
      ja: '完全な評価のために必要なすべてのデータが利用可能か確認してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/quality-evaluate`,
  },

  NETWORK_SLOW: {
    severity: 'warning',
    message: {
      en: 'Network response is slow ({responseTimeMs}ms)',
      ja: 'ネットワークレスポンスが遅いです（{responseTimeMs}ms）',
    },
    impact: {
      en: 'Analysis may take longer. Some resources may timeout.',
      ja: '分析に時間がかかる可能性があります。一部のリソースがタイムアウトする場合があります。',
    },
    action: {
      en: 'Increase timeout values. Check network connectivity.',
      ja: 'タイムアウト値を増やしてください。ネットワーク接続を確認してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#network`,
  },

  BROWSER_RESOURCE_LIMIT: {
    severity: 'warning',
    message: {
      en: 'Browser resource limit reached',
      ja: 'ブラウザリソース制限に達しました',
    },
    impact: {
      en: 'Some browser-based analysis may be skipped.',
      ja: '一部のブラウザベースの分析がスキップされる場合があります。',
    },
    action: {
      en: 'Reduce concurrent analysis. Close unused browser contexts.',
      ja: '並行分析を減らしてください。未使用のブラウザコンテキストを閉じてください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#browser-resources`,
  },

  PROCESSING_TIME_EXCEEDED: {
    severity: 'info',
    message: {
      en: 'Processing time ({actualTimeMs}ms) exceeded target ({targetTimeMs}ms)',
      ja: '処理時間（{actualTimeMs}ms）が目標（{targetTimeMs}ms）を超えました',
    },
    impact: {
      en: 'Analysis completed but took longer than expected.',
      ja: '分析は完了しましたが、予想以上に時間がかかりました。',
    },
    action: {
      en: 'Consider using summary=true or disabling optional features.',
      ja: 'summary=trueの使用またはオプション機能の無効化を検討してください。',
    },
    docs: `${DOCS_BASE_URL}/best-practices#performance`,
  },

  // Page-level errors (v0.1.0)
  PAGE_TIMEOUT: {
    severity: 'error',
    message: {
      en: 'Page analysis timed out for {url} after {timeoutMs}ms',
      ja: '{url}のページ分析が{timeoutMs}ms後にタイムアウトしました',
    },
    impact: {
      en: 'Page analysis could not complete. Results are unavailable.',
      ja: 'ページ分析が完了できませんでした。結果は利用できません。',
    },
    action: {
      en: 'Increase timeout parameter or check if the URL is accessible. Consider using summary=true for faster processing.',
      ja: 'timeoutパラメータを延長するか、URLにアクセス可能か確認してください。summary=trueで高速処理を検討してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#page-timeout`,
  },

  NETWORK_ERROR: {
    severity: 'error',
    message: {
      en: 'Network error while fetching {url}: {errorDetail}',
      ja: '{url}の取得中にネットワークエラーが発生しました: {errorDetail}',
    },
    impact: {
      en: 'Page could not be loaded. Analysis cannot proceed.',
      ja: 'ページを読み込めませんでした。分析を続行できません。',
    },
    action: {
      en: 'Check network connectivity and verify the URL is correct. Ensure the target server is running.',
      ja: 'ネットワーク接続を確認し、URLが正しいか確認してください。ターゲットサーバーが稼働しているか確認してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#network-error`,
  },

  HTTP_ERROR: {
    severity: 'error',
    message: {
      en: 'HTTP error {statusCode} when fetching {url}',
      ja: '{url}の取得時にHTTPエラー{statusCode}が発生しました',
    },
    impact: {
      en: 'Page returned an error status. Content may not be available.',
      ja: 'ページがエラーステータスを返しました。コンテンツが利用できない可能性があります。',
    },
    action: {
      en: 'Check if the URL exists and is accessible. For 403/401 errors, authentication may be required.',
      ja: 'URLが存在し、アクセス可能か確認してください。403/401エラーの場合、認証が必要な場合があります。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#http-error`,
  },

  BROWSER_ERROR: {
    severity: 'error',
    message: {
      en: 'Browser error: {errorDetail}',
      ja: 'ブラウザエラー: {errorDetail}',
    },
    impact: {
      en: 'Browser-based analysis failed. Playwright/Chromium may have encountered an issue.',
      ja: 'ブラウザベースの分析が失敗しました。Playwright/Chromiumで問題が発生した可能性があります。',
    },
    action: {
      en: 'Restart the analysis or check Playwright installation: npx playwright install chromium',
      ja: '分析を再開するか、Playwrightのインストールを確認してください: npx playwright install chromium',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting#browser-error`,
  },

  VISION_UNAVAILABLE: {
    severity: 'warning',
    message: {
      en: 'Vision analysis is unavailable',
      ja: 'Vision分析が利用できません',
    },
    impact: {
      en: 'Visual feature extraction will use HTML-only fallback. Mood and brand tone analysis unavailable.',
      ja: 'Visual feature抽出はHTMLのみのフォールバックを使用します。ムードとブランドトーン分析が利用できません。',
    },
    action: {
      en: 'Ensure Ollama is running with llama3.2-vision model: ollama serve && ollama pull llama3.2-vision',
      ja: 'Ollamaがllama3.2-visionモデルで起動しているか確認してください: ollama serve && ollama pull llama3.2-vision',
    },
    docs: `${DOCS_BASE_URL}/setup/vision-ai`,
  },

  NO_SECTIONS_DETECTED: {
    severity: 'warning',
    message: {
      en: 'No sections detected on {url}',
      ja: '{url}でセクションが検出されませんでした',
    },
    impact: {
      en: 'Layout analysis found no recognizable sections. This may indicate a non-standard page structure.',
      ja: 'レイアウト分析で認識可能なセクションが見つかりませんでした。非標準のページ構造を示している可能性があります。',
    },
    action: {
      en: 'Check if the page uses semantic HTML (section, article, header, footer). Ensure content is visible.',
      ja: 'ページがセマンティックHTML（section, article, header, footer）を使用しているか確認してください。コンテンツが表示されていることを確認してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/layout-inspect#no-sections`,
  },

  NO_ANIMATIONS_DETECTED: {
    severity: 'info',
    message: {
      en: 'No animations detected on {url}',
      ja: '{url}でアニメーションが検出されませんでした',
    },
    impact: {
      en: 'Motion analysis found no CSS animations, transitions, or keyframes. This is normal for static pages.',
      ja: 'モーション分析でCSSアニメーション、トランジション、キーフレームが見つかりませんでした。静的ページでは正常です。',
    },
    action: {
      en: 'If animations are expected, enable detect_js_animations for JavaScript-based animations.',
      ja: 'アニメーションが期待される場合、JavaScriptベースのアニメーション用にdetect_js_animationsを有効にしてください。',
    },
    docs: `${DOCS_BASE_URL}/tools/motion-detect#no-animations`,
  },

  LOW_QUALITY_SCORE: {
    severity: 'warning',
    message: {
      en: 'Quality score is below threshold: {score}/100 ({axis})',
      ja: '品質スコアがしきい値を下回っています: {score}/100（{axis}）',
    },
    impact: {
      en: 'Design quality may need improvement in the {axis} area.',
      ja: '{axis}の領域でデザイン品質の改善が必要な可能性があります。',
    },
    action: {
      en: 'Review quality.evaluate recommendations for specific improvement suggestions.',
      ja: '具体的な改善提案についてquality.evaluateの推奨事項を確認してください。',
    },
    docs: `${DOCS_BASE_URL}/tools/quality-evaluate#low-score`,
  },

  UNKNOWN: {
    severity: 'warning',
    message: {
      en: 'Unknown error occurred: {errorDetail}',
      ja: '不明なエラーが発生しました: {errorDetail}',
    },
    impact: {
      en: 'An unexpected error occurred during analysis.',
      ja: '分析中に予期しないエラーが発生しました。',
    },
    action: {
      en: 'Check logs for details. If the issue persists, please report it.',
      ja: '詳細についてログを確認してください。問題が続く場合は報告してください。',
    },
    docs: `${DOCS_BASE_URL}/troubleshooting`,
  },
};

// =============================================================================
// 警告生成関数
// =============================================================================

/**
 * テンプレート変数を置換
 */
function replaceVariables(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    return context[key] !== undefined ? String(context[key]) : `{${key}}`;
  });
}

/**
 * アクショナブル警告を生成
 */
export function createWarning(
  code: keyof typeof WARNING_CODES,
  context: Record<string, unknown> = {}
): ActionableWarning {
  const template = WARNING_TEMPLATES[code];

  if (!template) {
    // 未知のコードの場合はデフォルト警告を返す
    return {
      type: 'warning',
      code,
      severity: 'warning',
      message: `Unknown warning: ${code}`,
      impact: 'Unknown impact',
      action: 'Check documentation for details',
      context,
    };
  }

  const locale = currentLocale;

  // exactOptionalPropertyTypes対応: contextが空の場合はプロパティ自体を含めない
  const result: ActionableWarning = {
    type: 'warning',
    code,
    severity: template.severity,
    message: replaceVariables(template.message[locale], context),
    impact: replaceVariables(template.impact[locale], context),
    action: replaceVariables(template.action[locale], context),
    docs: template.docs,
  };
  if (Object.keys(context).length > 0) {
    result.context = context;
  }
  return result;
}

// =============================================================================
// WarningFactory クラス
// =============================================================================

/**
 * 警告を簡単に生成するためのファクトリクラス
 */
export class WarningFactory {
  /** レイアウトタイムアウト警告 */
  static layoutTimeout(actualTimeMs: number, configuredTimeoutMs: number): ActionableWarning {
    return createWarning('LAYOUT_TIMEOUT', { actualTimeMs, configuredTimeoutMs });
  }

  /** モーションタイムアウト警告 */
  static motionTimeout(actualTimeMs: number, configuredTimeoutMs: number): ActionableWarning {
    return createWarning('MOTION_TIMEOUT', { actualTimeMs, configuredTimeoutMs });
  }

  /** 品質タイムアウト警告 */
  static qualityTimeout(actualTimeMs: number, configuredTimeoutMs: number): ActionableWarning {
    return createWarning('QUALITY_TIMEOUT', { actualTimeMs, configuredTimeoutMs });
  }

  /** Vision AI利用不可警告 */
  static visionUnavailable(service: string, reason: string): ActionableWarning {
    return createWarning('VISION_AI_UNAVAILABLE', { service, reason });
  }

  /** Vision分析失敗警告 */
  static visionAnalysisFailed(reason: string): ActionableWarning {
    return createWarning('VISION_ANALYSIS_FAILED', { reason });
  }

  /** JSアニメーションスキップ警告 */
  static jsAnimationSkipped(reason: string): ActionableWarning {
    return createWarning('JS_ANIMATION_SKIPPED', { reason });
  }

  /** WebGLアニメーションスキップ警告 */
  static webglAnimationSkipped(reason: string): ActionableWarning {
    return createWarning('WEBGL_ANIMATION_SKIPPED', { reason });
  }

  /** フレームキャプチャ失敗警告 */
  static frameCaptureFailed(reason: string, framesAttempted?: number): ActionableWarning {
    return createWarning('FRAME_CAPTURE_FAILED', { reason, framesAttempted });
  }

  /** 外部CSS取得失敗警告 */
  static externalCssFetchFailed(
    urls: string[],
    failedCount: number,
    totalCount: number
  ): ActionableWarning {
    return createWarning('EXTERNAL_CSS_FETCH_FAILED', {
      failedUrls: urls,
      failedCount,
      totalCount,
    });
  }

  /** レスポンスサイズ大警告 */
  static responseSizeLarge(actualSizeKB: number, recommendedMaxKB: number): ActionableWarning {
    return createWarning('RESPONSE_SIZE_LARGE', { actualSizeKB, recommendedMaxKB });
  }

  /** ムードフォールバック警告 */
  static moodFallbackUsed(reason: string): ActionableWarning {
    return createWarning('MOOD_FALLBACK_USED', { reason });
  }

  /** ブランドトーンフォールバック警告 */
  static brandToneFallbackUsed(reason: string): ActionableWarning {
    return createWarning('BRAND_TONE_FALLBACK_USED', { reason });
  }

  /** レイアウト部分結果警告 */
  static layoutPartial(): ActionableWarning {
    return createWarning('LAYOUT_PARTIAL', {});
  }

  /** CSSフレームワーク不明警告 */
  static cssFrameworkUnknown(): ActionableWarning {
    return createWarning('CSS_FRAMEWORK_UNKNOWN', {});
  }

  /** モーション検出部分結果警告 */
  static motionDetectionPartial(): ActionableWarning {
    return createWarning('MOTION_DETECTION_PARTIAL', {});
  }

  /** 品質評価部分結果警告 */
  static qualityEvaluationPartial(): ActionableWarning {
    return createWarning('QUALITY_EVALUATION_PARTIAL', {});
  }

  /** ネットワーク遅延警告 */
  static networkSlow(responseTimeMs: number): ActionableWarning {
    return createWarning('NETWORK_SLOW', { responseTimeMs });
  }

  /** ブラウザリソース制限警告 */
  static browserResourceLimit(): ActionableWarning {
    return createWarning('BROWSER_RESOURCE_LIMIT', {});
  }

  /** 処理時間超過警告 */
  static processingTimeExceeded(actualTimeMs: number, targetTimeMs: number): ActionableWarning {
    return createWarning('PROCESSING_TIME_EXCEEDED', { actualTimeMs, targetTimeMs });
  }

  // =============================================================================
  // Page-level errors (v0.1.0)
  // =============================================================================

  /** ページタイムアウト警告 */
  static pageTimeout(url: string, timeoutMs: number): ActionableWarning {
    return createWarning('PAGE_TIMEOUT', { url, timeoutMs });
  }

  /** ネットワークエラー警告 */
  static networkError(url: string, errorDetail: string): ActionableWarning {
    return createWarning('NETWORK_ERROR', { url, errorDetail });
  }

  /** HTTPエラー警告 */
  static httpError(url: string, statusCode: number): ActionableWarning {
    return createWarning('HTTP_ERROR', { url, statusCode });
  }

  /** ブラウザエラー警告 */
  static browserError(errorDetail: string): ActionableWarning {
    return createWarning('BROWSER_ERROR', { errorDetail });
  }

  /** Vision利用不可警告（シンプル版） */
  static visionUnavailableSimple(): ActionableWarning {
    return createWarning('VISION_UNAVAILABLE', {});
  }

  /** セクション未検出警告 */
  static noSectionsDetected(url: string): ActionableWarning {
    return createWarning('NO_SECTIONS_DETECTED', { url });
  }

  /** アニメーション未検出警告 */
  static noAnimationsDetected(url: string): ActionableWarning {
    return createWarning('NO_ANIMATIONS_DETECTED', { url });
  }

  /** 低品質スコア警告 */
  static lowQualityScore(score: number, axis: string): ActionableWarning {
    return createWarning('LOW_QUALITY_SCORE', { score, axis });
  }

  /** 未知のエラー警告 */
  static unknown(errorDetail: string): ActionableWarning {
    return createWarning('UNKNOWN', { errorDetail });
  }
}

// =============================================================================
// フォーマット関数
// =============================================================================

/**
 * 単一の警告をテキスト形式にフォーマット
 */
function formatSingleWarningText(warning: ActionableWarning): string {
  const lines = [
    `[${warning.code}] ${warning.message}`,
    `  Impact: ${warning.impact}`,
    `  Action: ${warning.action}`,
  ];

  if (warning.docs) {
    lines.push(`  Docs: ${warning.docs}`);
  }

  return lines.join('\n');
}

/**
 * 単一の警告を簡易形式にフォーマット
 */
function formatSingleWarningCompact(warning: ActionableWarning): string {
  return `[${warning.code}] ${warning.message} - ${warning.action}`;
}

/**
 * 警告メッセージをフォーマット
 */
export function formatWarningMessage(
  warnings: ActionableWarning | ActionableWarning[],
  options: FormatOptions = {}
): string {
  const { format = 'text', separator = '\n\n' } = options;
  const warningArray = Array.isArray(warnings) ? warnings : [warnings];

  switch (format) {
    case 'json':
      return JSON.stringify(
        warningArray.length === 1 ? warningArray[0] : warningArray,
        null,
        2
      );

    case 'compact':
      return warningArray.map(formatSingleWarningCompact).join(separator);

    case 'text':
    default:
      return warningArray.map(formatSingleWarningText).join(separator);
  }
}

// =============================================================================
// 後方互換性
// =============================================================================

/** 旧形式のコードから新形式へのマッピング */
const LEGACY_CODE_MAP: Record<string, keyof typeof WARNING_CODES> = {
  // Timeout errors
  TIMEOUT_ERROR: 'LAYOUT_TIMEOUT',
  LAYOUT_ANALYSIS_FAILED: 'LAYOUT_PARTIAL',
  MOTION_DETECTION_FAILED: 'MOTION_DETECTION_PARTIAL',
  QUALITY_EVALUATION_FAILED: 'QUALITY_EVALUATION_PARTIAL',

  // Network errors
  NETWORK_ERROR: 'NETWORK_SLOW',
  HTTP_ERROR: 'NETWORK_SLOW',

  // Browser errors
  BROWSER_ERROR: 'BROWSER_RESOURCE_LIMIT',
  BROWSER_UNAVAILABLE: 'BROWSER_RESOURCE_LIMIT',
};

/**
 * 旧形式の警告をアクショナブル警告に変換
 */
export function legacyWarningToActionable(legacy: LegacyWarning): ActionableWarning {
  // 旧形式のコードから新形式を特定
  let newCode: keyof typeof WARNING_CODES | undefined;

  // 1. 直接マッピングを確認
  if (legacy.code in LEGACY_CODE_MAP) {
    newCode = LEGACY_CODE_MAP[legacy.code];
  }

  // 2. featureに基づいてタイムアウトコードを決定
  if (!newCode && legacy.code.includes('TIMEOUT')) {
    switch (legacy.feature) {
      case 'layout':
        newCode = 'LAYOUT_TIMEOUT';
        break;
      case 'motion':
        newCode = 'MOTION_TIMEOUT';
        break;
      case 'quality':
        newCode = 'QUALITY_TIMEOUT';
        break;
    }
  }

  // 3. featureに基づいてpartialコードを決定
  if (!newCode && (legacy.code.includes('PARTIAL') || legacy.code.includes('FAILED'))) {
    switch (legacy.feature) {
      case 'layout':
        newCode = 'LAYOUT_PARTIAL';
        break;
      case 'motion':
        newCode = 'MOTION_DETECTION_PARTIAL';
        break;
      case 'quality':
        newCode = 'QUALITY_EVALUATION_PARTIAL';
        break;
    }
  }

  // 4. デフォルトフォールバック
  if (!newCode) {
    switch (legacy.feature) {
      case 'layout':
        newCode = 'LAYOUT_PARTIAL';
        break;
      case 'motion':
        newCode = 'MOTION_DETECTION_PARTIAL';
        break;
      case 'quality':
        newCode = 'QUALITY_EVALUATION_PARTIAL';
        break;
      default:
        newCode = 'LAYOUT_PARTIAL';
    }
  }

  // 新形式の警告を生成
  const warning = createWarning(newCode, {
    legacyCode: legacy.code,
    legacyMessage: legacy.message,
    feature: legacy.feature,
  });

  // 旧形式のメッセージを保持（より具体的な場合があるため）
  if (legacy.message && legacy.message.length > warning.message.length) {
    return {
      ...warning,
      message: legacy.message,
    };
  }

  return warning;
}
