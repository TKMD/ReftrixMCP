// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExistingAnimationDetectorService
 *
 * プロジェクト内の既存CSSアニメーション（@keyframes）を検出し、
 * 新規生成時に重複チェックを行うサービス
 *
 * 機能:
 * - CSSファイルから@keyframesを解析
 * - アニメーション名、プロパティ、キーフレームの抽出
 * - 類似度計算による重複検出
 * - 既存アニメーションの使用提案
 *
 * @module services/motion/existing-animation-detector.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * キーフレーム情報
 */
export interface Keyframe {
  /** オフセット (0-1, 0=from/0%, 1=to/100%) */
  offset: number;
  /** プロパティと値のマップ */
  properties: Record<string, string>;
}

/**
 * 既存アニメーション情報
 */
export interface ExistingAnimation {
  /** アニメーション名 */
  name: string;
  /** ファイルパス */
  filePath: string;
  /** 生CSS文字列 */
  rawCSS: string;
  /** アニメーションで使用されるプロパティ名のリスト */
  properties: string[];
  /** キーフレーム情報 */
  keyframes: Keyframe[];
}

/**
 * 新規生成パターン（motion.searchのpatternに相当）
 */
export interface NewAnimationPattern {
  /** アニメーション名 */
  name: string;
  /** プロパティ定義 */
  properties: Array<{
    name: string;
    from: string;
    to: string;
    keyframes?: Array<{
      offset: number;
      value: string;
    }>;
  }>;
  /** タイプ */
  type: 'animation' | 'transition' | 'transform' | 'scroll' | 'hover' | 'keyframe';
  /** 継続時間(ms) */
  duration: number;
  /** イージング */
  easing: string;
}

/**
 * 重複一致情報
 */
export interface AnimationMatch {
  /** 既存アニメーション名 */
  animationName: string;
  /** ファイルパス */
  filePath: string;
  /** 類似度 (0-1) */
  similarity: number;
  /** 提案メッセージ */
  suggestion: string;
}

/**
 * 重複チェック結果
 */
export interface DuplicateCheckResult {
  /** 重複があるか */
  hasDuplicates: boolean;
  /** マッチした既存アニメーション */
  existingMatches: AnimationMatch[];
  /** 警告メッセージ */
  warnings: string[];
}

/**
 * 重複チェックオプション
 */
export interface DuplicateCheckOptions {
  /** 単一CSSファイルパス */
  projectCSSPath?: string;
  /** 複数CSSファイルパス */
  projectCSSPaths?: string[];
  /** 類似度しきい値 (0-1, デフォルト: 0.8) */
  similarityThreshold?: number;
}

// =====================================================
// 定数
// =====================================================

/** ベンダープレフィックス付きの@keyframesを検出する正規表現 */
const VENDOR_KEYFRAMES_REGEX = /@-(?:webkit|moz|ms|o)-keyframes/;

/** キーフレームのオフセットと内容を検出する正規表現（複合オフセット対応） */
const KEYFRAME_BLOCK_REGEX = /((?:from|to|\d+%(?:\s*,\s*(?:from|to|\d+%))*)\s*)\{([^}]*)\}/g;

/** CSSプロパティと値を検出する正規表現 */
const CSS_PROPERTY_REGEX = /([a-zA-Z-]+)\s*:\s*([^;]+);/g;

/** デフォルトの類似度しきい値 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

// =====================================================
// サービスクラス
// =====================================================

/**
 * 既存アニメーション検出サービス
 */
export class ExistingAnimationDetectorService {
  /** アニメーションレジストリキャッシュ */
  private registryCache: Map<string, ExistingAnimation> | null = null;

  /**
   * CSSファイルから@keyframesを解析
   *
   * @param filePath CSSファイルパス
   * @returns 検出されたアニメーションの配列
   */
  async scanCSSFile(filePath: string): Promise<ExistingAnimation[]> {
    const animations: ExistingAnimation[] = [];

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = this.parseCSSContent(content, filePath);
      animations.push(...parsed);

      if (isDevelopment()) {
        logger.debug('[ExistingAnimationDetector] Scanned CSS file', {
          filePath,
          animationCount: animations.length,
        });
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[ExistingAnimationDetector] Failed to scan CSS file', {
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // ファイル読み取りエラーは空配列を返す
    }

    return animations;
  }

  /**
   * CSS文字列から@keyframesを解析
   *
   * @param content CSS文字列
   * @param filePath ソースファイルパス
   * @returns 検出されたアニメーションの配列
   */
  parseCSSContent(content: string, filePath: string): ExistingAnimation[] {
    const animations: ExistingAnimation[] = [];

    // ベンダープレフィックス付きのkeyframesを除外するためにクリーン
    // より正確なネスト対応の除外処理
    let cleanedContent = content;
    cleanedContent = this.removeVendorKeyframes(cleanedContent);

    // @keyframesをマニュアルでパース（ネスト構造対応）
    const keyframeBlocks = this.extractKeyframeBlocks(cleanedContent);

    for (const block of keyframeBlocks) {
      // ベンダープレフィックス付きはスキップ
      if (VENDOR_KEYFRAMES_REGEX.test(block.raw)) {
        continue;
      }

      // 名前がない場合はスキップ
      if (!block.name || block.name.trim() === '') {
        continue;
      }

      try {
        const keyframes = this.parseKeyframeBody(block.body);
        const properties = this.extractProperties(keyframes);

        animations.push({
          name: block.name,
          filePath,
          rawCSS: block.raw,
          properties,
          keyframes,
        });
      } catch {
        // パースエラーはスキップして続行
        if (isDevelopment()) {
          logger.debug('[ExistingAnimationDetector] Failed to parse keyframe', { name: block.name });
        }
      }
    }

    return animations;
  }

  /**
   * ベンダープレフィックス付きkeyframesを除去
   */
  private removeVendorKeyframes(content: string): string {
    let result = content;
    const vendorPrefixes = ['-webkit-', '-moz-', '-ms-', '-o-'];

    for (const prefix of vendorPrefixes) {
      const regex = new RegExp(`@${prefix}keyframes\\s+[\\w-]+\\s*\\{`, 'g');
      let match: RegExpExecArray | null;

      while ((match = regex.exec(result)) !== null) {
        const startIndex = match.index;
        const endIndex = this.findMatchingBrace(result, startIndex + match[0].length - 1);
        if (endIndex > startIndex) {
          result = result.slice(0, startIndex) + result.slice(endIndex + 1);
          regex.lastIndex = startIndex;
        }
      }
    }

    return result;
  }

  /**
   * @keyframesブロックを抽出
   */
  private extractKeyframeBlocks(content: string): Array<{ name: string; body: string; raw: string }> {
    const blocks: Array<{ name: string; body: string; raw: string }> = [];
    const regex = /@keyframes\s+([a-zA-Z_][\w-]*)\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!name) continue; // 名前がない場合はスキップ

      const openBraceIndex = match.index + match[0].length - 1;
      const closeBraceIndex = this.findMatchingBrace(content, openBraceIndex);

      if (closeBraceIndex > openBraceIndex) {
        const body = content.slice(openBraceIndex + 1, closeBraceIndex);
        const raw = content.slice(match.index, closeBraceIndex + 1);
        blocks.push({ name, body, raw });
      }
    }

    return blocks;
  }

  /**
   * 対応する閉じブレースを見つける
   */
  private findMatchingBrace(content: string, openIndex: number): number {
    let depth = 1;
    let i = openIndex + 1;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') {
        depth++;
      } else if (content[i] === '}') {
        depth--;
      }
      i++;
    }

    return depth === 0 ? i - 1 : -1;
  }

  /**
   * キーフレームの本体を解析
   *
   * @param body @keyframes内の本体文字列
   * @returns キーフレーム配列
   */
  private parseKeyframeBody(body: string): Keyframe[] {
    const keyframes: Keyframe[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(KEYFRAME_BLOCK_REGEX.source, 'g');

    while ((match = regex.exec(body)) !== null) {
      const offsetsRaw = match[1];
      const propsStr = match[2];
      if (!offsetsRaw || !propsStr) continue;

      const offsetsStr = offsetsRaw.trim();

      // プロパティを抽出
      const properties: Record<string, string> = {};
      let propMatch: RegExpExecArray | null;
      const propRegex = new RegExp(CSS_PROPERTY_REGEX.source, 'g');

      while ((propMatch = propRegex.exec(propsStr)) !== null) {
        const propName = propMatch[1];
        const propValue = propMatch[2];
        if (propName && propValue) {
          properties[propName.trim()] = propValue.trim();
        }
      }

      // 複合オフセットを解析（例: "0%, 100%"）
      const offsets = this.parseOffsets(offsetsStr);

      for (const offset of offsets) {
        keyframes.push({ offset, properties: { ...properties } });
      }
    }

    // オフセットでソート
    keyframes.sort((a, b) => a.offset - b.offset);

    // 重複オフセットをマージ（同じオフセットのプロパティを結合）
    const mergedKeyframes: Keyframe[] = [];
    for (const kf of keyframes) {
      const existing = mergedKeyframes.find(m => m.offset === kf.offset);
      if (existing) {
        Object.assign(existing.properties, kf.properties);
      } else {
        mergedKeyframes.push(kf);
      }
    }

    return mergedKeyframes;
  }

  /**
   * オフセット文字列を数値配列に変換
   * @param offsetsStr "from", "to", "50%", "0%, 100%" などの形式
   */
  private parseOffsets(offsetsStr: string): number[] {
    const offsets: number[] = [];
    const parts = offsetsStr.split(',').map(s => s.trim());

    for (const part of parts) {
      if (part === 'from') {
        offsets.push(0);
      } else if (part === 'to') {
        offsets.push(1);
      } else if (part.endsWith('%')) {
        const num = parseFloat(part);
        if (!isNaN(num)) {
          offsets.push(num / 100);
        }
      }
    }

    return offsets;
  }

  /**
   * キーフレームからプロパティ名を抽出
   *
   * @param keyframes キーフレーム配列
   * @returns プロパティ名の配列
   */
  private extractProperties(keyframes: Keyframe[]): string[] {
    const propertySet = new Set<string>();

    for (const kf of keyframes) {
      for (const prop of Object.keys(kf.properties)) {
        propertySet.add(prop);
      }
    }

    return Array.from(propertySet);
  }

  /**
   * 既存アニメーションと新規パターンの類似度を計算
   *
   * 類似度は以下の要素で計算:
   * - 名前の類似性（大文字小文字無視）: 20%
   * - プロパティの重複率: 60%（最重要）
   * - 値の類似性（開始/終了値）: 20%
   *
   * @param existing 既存アニメーション
   * @param newPattern 新規パターン
   * @returns 類似度 (0-1)
   */
  calculateSimilarity(existing: ExistingAnimation, newPattern: NewAnimationPattern): number {
    // 1. 名前の類似性 (重み: 0.2)
    const nameSimilarity = this.calculateNameSimilarity(existing.name, newPattern.name);

    // 2. プロパティの重複率 (重み: 0.6 - 最重要)
    const newPropertyNames = newPattern.properties.map(p => p.name);
    const propertySimilarity = this.calculatePropertySimilarity(existing.properties, newPropertyNames);

    // 3. 値の類似性 (重み: 0.2)
    const valueSimilarity = this.calculateValueSimilarity(existing, newPattern);

    // 重み付け合計
    const similarity = nameSimilarity * 0.2 + propertySimilarity * 0.6 + valueSimilarity * 0.2;

    return similarity;
  }

  /**
   * 名前の類似性を計算（Levenshtein距離ベース）
   */
  private calculateNameSimilarity(name1: string, name2: string): number {
    const n1 = name1.toLowerCase();
    const n2 = name2.toLowerCase();

    // 完全一致
    if (n1 === n2) return 1;

    // 片方が他方を含む
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;

    // Levenshtein距離
    const distance = this.levenshteinDistance(n1, n2);
    const maxLen = Math.max(n1.length, n2.length);
    return maxLen > 0 ? Math.max(0, 1 - distance / maxLen) : 0;
  }

  /**
   * Levenshtein距離を計算
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = [];

    // 配列を初期化
    for (let i = 0; i <= m; i++) {
      dp[i] = new Array<number>(n + 1).fill(0);
    }

    for (let i = 0; i <= m; i++) {
      const row = dp[i];
      if (row) row[0] = i;
    }
    for (let j = 0; j <= n; j++) {
      const row = dp[0];
      if (row) row[j] = j;
    }

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const char1 = str1[i - 1];
        const char2 = str2[j - 1];
        const prevRow = dp[i - 1];
        const currRow = dp[i];

        if (!prevRow || !currRow) continue;

        const prevDiag = prevRow[j - 1] ?? 0;
        const prevUp = prevRow[j] ?? 0;
        const prevLeft = currRow[j - 1] ?? 0;

        if (char1 === char2) {
          currRow[j] = prevDiag;
        } else {
          currRow[j] = 1 + Math.min(prevUp, prevLeft, prevDiag);
        }
      }
    }

    const lastRow = dp[m];
    return lastRow?.[n] ?? 0;
  }

  /**
   * プロパティの重複率を計算
   */
  private calculatePropertySimilarity(existingProps: string[], newProps: string[]): number {
    if (existingProps.length === 0 && newProps.length === 0) return 1;
    if (existingProps.length === 0 || newProps.length === 0) return 0;

    const existingSet = new Set(existingProps.map(p => p.toLowerCase()));
    const newSet = new Set(newProps.map(p => p.toLowerCase()));

    const intersection = [...newSet].filter(p => existingSet.has(p)).length;
    const union = new Set([...existingSet, ...newSet]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * 値の類似性を計算
   */
  private calculateValueSimilarity(existing: ExistingAnimation, newPattern: NewAnimationPattern): number {
    if (existing.keyframes.length === 0 || newPattern.properties.length === 0) {
      return 0;
    }

    let totalSimilarity = 0;
    let count = 0;

    // 新規パターンの各プロパティについて既存との類似性を計算
    for (const newProp of newPattern.properties) {
      const propName = newProp.name.toLowerCase();

      // 既存のキーフレームから該当プロパティを検索
      const startKf = existing.keyframes.find(kf => kf.offset === 0);
      const endKf = existing.keyframes.find(kf => kf.offset === 1);

      let existingFrom: string | undefined;
      let existingTo: string | undefined;

      if (startKf) {
        existingFrom = Object.entries(startKf.properties)
          .find(([k]) => k.toLowerCase() === propName)?.[1];
      }
      if (endKf) {
        existingTo = Object.entries(endKf.properties)
          .find(([k]) => k.toLowerCase() === propName)?.[1];
      }

      if (existingFrom && existingTo) {
        // 値の文字列類似性
        const fromSim = this.calculateValueStringSimilarity(existingFrom, newProp.from);
        const toSim = this.calculateValueStringSimilarity(existingTo, newProp.to);
        totalSimilarity += (fromSim + toSim) / 2;
        count++;
      }
    }

    return count > 0 ? totalSimilarity / count : 0;
  }

  /**
   * CSS値の文字列類似性を計算
   */
  private calculateValueStringSimilarity(val1: string, val2: string): number {
    const v1 = val1.trim().toLowerCase();
    const v2 = val2.trim().toLowerCase();

    if (v1 === v2) return 1;

    // 数値の抽出と比較
    const num1 = parseFloat(v1);
    const num2 = parseFloat(v2);

    if (!isNaN(num1) && !isNaN(num2)) {
      const maxNum = Math.max(Math.abs(num1), Math.abs(num2), 1);
      return Math.max(0, 1 - Math.abs(num1 - num2) / maxNum);
    }

    // 文字列の類似性
    const distance = this.levenshteinDistance(v1, v2);
    const maxLen = Math.max(v1.length, v2.length);
    return maxLen > 0 ? Math.max(0, 1 - distance / maxLen) : 0;
  }

  /**
   * 重複チェックを実行
   *
   * @param newPattern 新規生成パターン
   * @param options チェックオプション
   * @returns 重複チェック結果
   */
  async checkDuplicates(
    newPattern: NewAnimationPattern,
    options: DuplicateCheckOptions
  ): Promise<DuplicateCheckResult> {
    const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const existingMatches: AnimationMatch[] = [];
    const warnings: string[] = [];

    // CSSファイルパスを収集
    const cssFiles: string[] = [];
    if (options.projectCSSPath) {
      cssFiles.push(options.projectCSSPath);
    }
    if (options.projectCSSPaths) {
      cssFiles.push(...options.projectCSSPaths);
    }

    // 全CSSファイルをスキャン
    const allAnimations: ExistingAnimation[] = [];
    for (const filePath of cssFiles) {
      const animations = await this.scanCSSFile(filePath);
      allAnimations.push(...animations);
    }

    // 各既存アニメーションと比較
    for (const existing of allAnimations) {
      const similarity = this.calculateSimilarity(existing, newPattern);

      if (similarity >= threshold) {
        const fileName = path.basename(existing.filePath);
        const suggestion = similarity >= 0.9
          ? `Use existing '${existing.name}' from ${fileName} instead of generating new animation`
          : `Consider using existing '${existing.name}' from ${fileName} (${Math.round(similarity * 100)}% similar)`;

        existingMatches.push({
          animationName: existing.name,
          filePath: existing.filePath,
          similarity,
          suggestion,
        });

        warnings.push(
          `Similar animation '${existing.name}' found in ${fileName} (${Math.round(similarity * 100)}% match)`
        );
      }
    }

    // 類似度で降順ソート
    existingMatches.sort((a, b) => b.similarity - a.similarity);

    if (isDevelopment()) {
      logger.info('[ExistingAnimationDetector] Duplicate check completed', {
        patternName: newPattern.name,
        scannedFiles: cssFiles.length,
        totalAnimations: allAnimations.length,
        matchesFound: existingMatches.length,
        threshold,
      });
    }

    return {
      hasDuplicates: existingMatches.length > 0,
      existingMatches,
      warnings,
    };
  }

  /**
   * ディレクトリ内の全CSSファイルをスキャン
   *
   * @param dirPath ディレクトリパス
   * @returns 検出されたアニメーションの配列
   */
  async scanDirectory(dirPath: string): Promise<ExistingAnimation[]> {
    const animations: ExistingAnimation[] = [];

    try {
      const entries = await fs.readdir(dirPath);

      for (const entry of entries) {
        if (!entry.endsWith('.css')) continue;

        const filePath = path.join(dirPath, entry);
        const stat = await fs.stat(filePath);

        if (stat.isFile()) {
          const fileAnimations = await this.scanCSSFile(filePath);
          animations.push(...fileAnimations);
        }
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[ExistingAnimationDetector] Failed to scan directory', {
          dirPath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return animations;
  }

  /**
   * アニメーションレジストリを構築
   *
   * @param cssFiles スキャンするCSSファイルパスの配列
   * @returns 名前をキーとするアニメーションのMap
   */
  async buildAnimationRegistry(cssFiles: string[]): Promise<Map<string, ExistingAnimation>> {
    const registry = new Map<string, ExistingAnimation>();

    for (const filePath of cssFiles) {
      const animations = await this.scanCSSFile(filePath);
      for (const anim of animations) {
        registry.set(anim.name, anim);
      }
    }

    this.registryCache = registry;
    return registry;
  }

  /**
   * キャッシュされたレジストリを取得
   */
  getRegistryCache(): Map<string, ExistingAnimation> | null {
    return this.registryCache;
  }

  /**
   * キャッシュをクリア
   */
  clearCache(): void {
    this.registryCache = null;
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let serviceInstance: ExistingAnimationDetectorService | null = null;

/**
 * ExistingAnimationDetectorServiceインスタンスを取得
 */
export function getExistingAnimationDetectorService(): ExistingAnimationDetectorService {
  if (!serviceInstance) {
    serviceInstance = new ExistingAnimationDetectorService();
  }
  return serviceInstance;
}

/**
 * ExistingAnimationDetectorServiceインスタンスをリセット
 */
export function resetExistingAnimationDetectorService(): void {
  serviceInstance?.clearCache();
  serviceInstance = null;
}

export default ExistingAnimationDetectorService;
