// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BriefParserService
 *
 * DESIGN_BRIEF.md から NG/OK 表現、カラーパレット、アセット要件を抽出するサービス
 *
 * @module services/brief/brief-parser-service
 */
import * as fs from 'fs/promises';
import type {
  ParsedBrief,
  ParseOptions,
  NgExpression,
  OkExpression,
  ColorToken,
  RequiredAsset,
} from './schemas/brief-parser-schemas';
import { createLogger, isDevelopment } from '../../utils/logger';

const logger = createLogger('BriefParserService');

// =============================================================================
// 定数
// =============================================================================

/** 最大ファイルサイズ（10MB） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * Markdownフォーマット（bold, italic, code）を除去
 */
function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold **text**
    .replace(/\*([^*]+)\*/g, '$1') // italic *text*
    .replace(/`([^`]+)`/g, '$1') // code `text`
    .trim();
}

/**
 * テーブル行をセルの配列にパース
 */
function parseTableRow(row: string): string[] | null {
  // パイプで囲まれた行のみ処理
  if (!row.startsWith('|') || !row.endsWith('|')) {
    return null;
  }

  // セパレータ行かどうかチェック
  if (/^\|[\s-:|]+\|$/.test(row)) {
    return null;
  }

  // 先頭と末尾のパイプを除去してセルに分割
  const inner = row.slice(1, -1);
  const cells = inner.split('|').map((cell) => stripMarkdownFormatting(cell));

  return cells;
}

/**
 * Markdownテーブルをパース
 * @returns ヘッダー行と各データ行の配列
 */
function parseMarkdownTable(
  content: string,
  sectionPattern: RegExp
): { headers: string[]; rows: string[][] } {
  const result: { headers: string[]; rows: string[][] } = {
    headers: [],
    rows: [],
  };

  // セクションを検索
  const sectionMatch = sectionPattern.exec(content);
  if (!sectionMatch) {
    return result;
  }

  // セクション開始位置から次のセクション開始まで（または終端まで）を取得
  const startIndex = sectionMatch.index + sectionMatch[0].length;
  const remainingContent = content.slice(startIndex);

  // 次のセクション（##, ###, ####で始まる行）までの範囲を取得
  const nextSectionMatch = /^#{2,4}\s+/m.exec(remainingContent);
  const sectionContent = nextSectionMatch
    ? remainingContent.slice(0, nextSectionMatch.index)
    : remainingContent;

  // テーブル行を抽出
  const lines = sectionContent.split('\n');
  let foundHeader = false;
  let foundSeparator = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine.startsWith('|')) {
      continue;
    }

    // セパレータ行をスキップ
    if (/^\|[\s-:|]+\|$/.test(trimmedLine)) {
      foundSeparator = true;
      continue;
    }

    const cells = parseTableRow(trimmedLine);
    if (!cells || cells.length === 0) {
      continue;
    }

    if (!foundHeader) {
      result.headers = cells;
      foundHeader = true;
    } else if (foundSeparator) {
      result.rows.push(cells);
    }
  }

  return result;
}

/**
 * ヘッダー名からカラムインデックスを取得
 */
function findColumnIndex(headers: string[], patterns: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const headerValue = headers[i];
    if (!headerValue) continue;
    const header = headerValue.toLowerCase();
    for (const pattern of patterns) {
      if (header.includes(pattern.toLowerCase())) {
        return i;
      }
    }
  }
  return -1;
}

// =============================================================================
// BriefParserService
// =============================================================================

/**
 * DESIGN_BRIEF.md パーサーサービス
 */
export class BriefParserService {
  /**
   * Markdownコンテンツをパースして構造化データを返す
   *
   * @param markdownContent - DESIGN_BRIEF.mdのMarkdownコンテンツ
   * @param options - パースオプション
   * @returns パース済みブリーフ
   * @throws strictモードでproject_nameがない場合
   */
  parse(markdownContent: string, options: ParseOptions = {}): ParsedBrief {
    const { sourcePath, strict = false } = options;

    if (isDevelopment()) {
      logger.info('Parsing brief', {
        contentLength: markdownContent.length,
        strict,
      });
    }

    // プロジェクト名抽出（H1見出し）
    const projectName = this.extractProjectName(markdownContent);

    if (strict && !projectName) {
      throw new Error('project_name is required in strict mode');
    }

    // 各セクション抽出
    const ngExpressions = this.extractNgExpressions(markdownContent);
    const okExpressions = this.extractOkExpressions(markdownContent);
    const colorTokens = this.extractColorPalette(markdownContent);
    const requiredAssets = this.extractRequiredAssets(markdownContent);

    const result: ParsedBrief = {
      project_name: projectName,
      color_palette: {
        tokens: colorTokens,
      },
      ng_expressions: ngExpressions,
      ok_expressions: okExpressions,
      required_assets: requiredAssets,
      parsed_at: new Date().toISOString(),
    };

    if (sourcePath) {
      result.source_path = sourcePath;
    }

    if (isDevelopment()) {
      logger.info('Brief parsed', {
        projectName,
        ngCount: ngExpressions.length,
        okCount: okExpressions.length,
        colorCount: colorTokens.length,
        assetCount: requiredAssets.length,
      });
    }

    return result;
  }

  /**
   * ファイルパスからパースする
   *
   * @param filePath - DESIGN_BRIEF.mdのファイルパス
   * @param options - パースオプション
   * @returns パース済みブリーフ
   * @throws ファイルが存在しない、または読み込みエラーの場合
   */
  async parseFile(
    filePath: string,
    options: ParseOptions = {}
  ): Promise<ParsedBrief> {
    try {
      // ファイルサイズチェック
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `ファイルサイズが上限(${MAX_FILE_SIZE / 1024 / 1024}MB)を超えています`
        );
      }

      const content = await fs.readFile(filePath, 'utf-8');

      return this.parse(content, {
        ...options,
        sourcePath: filePath,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        // [SEC] H-001: 本番環境でのファイルパス露出を防止
        throw new Error(
          isDevelopment()
            ? `ファイルが存在しません: ${filePath}`
            : 'ファイルが存在しません'
        );
      }
      throw error;
    }
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * プロジェクト名を抽出（H1見出し）
   */
  private extractProjectName(content: string): string {
    const h1Match = /^#\s+(.+)$/m.exec(content);
    return h1Match?.[1]?.trim() ?? '';
  }

  /**
   * NG表現を抽出
   * Anti-AI Expression List と NG Examples の両方から抽出してマージ
   */
  private extractNgExpressions(content: string): NgExpression[] {
    const expressions: NgExpression[] = [];

    // Pattern 1: Anti-AI Expression List (NG)
    const antiAiTable = parseMarkdownTable(
      content,
      /#{1,4}\s+Anti-AI Expression List\s*\(NG\)/i
    );

    if (antiAiTable.headers.length > 0) {
      const exprIndex = findColumnIndex(antiAiTable.headers, [
        'ng expression',
        'expression',
      ]);
      const reasonIndex = findColumnIndex(antiAiTable.headers, [
        'why ng',
        'why',
        'reason',
      ]);
      const altIndex = findColumnIndex(antiAiTable.headers, [
        'alternative',
        'alt',
      ]);

      for (const row of antiAiTable.rows) {
        const expression = exprIndex >= 0 ? row[exprIndex] : '';
        const reason = reasonIndex >= 0 ? row[reasonIndex] : '';

        if (expression && reason) {
          expressions.push({
            expression,
            reason,
            alternative: altIndex >= 0 && row[altIndex] ? row[altIndex] : undefined,
          });
        }
      }
    }

    // Pattern 2: NG Examples
    const ngExamplesTable = parseMarkdownTable(
      content,
      /#{1,4}\s+NG Examples/i
    );

    if (ngExamplesTable.headers.length > 0) {
      const ngIndex = findColumnIndex(ngExamplesTable.headers, ['ng']);
      const whyIndex = findColumnIndex(ngExamplesTable.headers, ['why']);

      for (const row of ngExamplesTable.rows) {
        const expression = ngIndex >= 0 ? row[ngIndex] : row[0];
        const reason = whyIndex >= 0 ? row[whyIndex] : row[1];

        if (expression && reason) {
          // 重複チェック
          const isDuplicate = expressions.some(
            (e) => e.expression === expression
          );
          if (!isDuplicate) {
            expressions.push({
              expression,
              reason,
            });
          }
        }
      }
    }

    return expressions;
  }

  /**
   * OK表現を抽出
   */
  private extractOkExpressions(content: string): OkExpression[] {
    const expressions: OkExpression[] = [];

    const okTable = parseMarkdownTable(content, /#{1,4}\s+OK Examples/i);

    if (okTable.headers.length > 0) {
      const okIndex = findColumnIndex(okTable.headers, ['ok']);
      const whyIndex = findColumnIndex(okTable.headers, ['why']);

      for (const row of okTable.rows) {
        const expression = okIndex >= 0 ? row[okIndex] : row[0];
        const reason = whyIndex >= 0 ? row[whyIndex] : row[1];

        if (expression && reason) {
          expressions.push({
            expression,
            reason,
          });
        }
      }
    }

    return expressions;
  }

  /**
   * カラーパレットを抽出
   */
  private extractColorPalette(content: string): ColorToken[] {
    const tokens: ColorToken[] = [];

    const paletteTable = parseMarkdownTable(content, /#{1,4}\s+Color Palette/i);

    if (paletteTable.headers.length > 0) {
      const tokenIndex = findColumnIndex(paletteTable.headers, ['token']);
      const roleIndex = findColumnIndex(paletteTable.headers, ['role']);
      const hexIndex = findColumnIndex(paletteTable.headers, ['hex']);
      const oklchIndex = findColumnIndex(paletteTable.headers, ['oklch']);
      const usageIndex = findColumnIndex(paletteTable.headers, ['usage']);

      for (const row of paletteTable.rows) {
        const name = tokenIndex >= 0 ? row[tokenIndex] : '';
        const hex = hexIndex >= 0 ? row[hexIndex] : '';

        // HEX値のバリデーション
        if (!name || !hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
          continue;
        }

        const token: ColorToken = {
          name,
          hex,
        };

        if (roleIndex >= 0 && row[roleIndex]) {
          token.role = row[roleIndex];
        }
        if (oklchIndex >= 0 && row[oklchIndex]) {
          token.oklch = row[oklchIndex];
        }
        if (usageIndex >= 0 && row[usageIndex]) {
          token.usage = row[usageIndex];
        }

        tokens.push(token);
      }
    }

    return tokens;
  }

  /**
   * 必要アセットを抽出
   */
  private extractRequiredAssets(content: string): RequiredAsset[] {
    const assets: RequiredAsset[] = [];

    const assetTable = parseMarkdownTable(content, /#{1,4}\s+Asset Categories/i);

    if (assetTable.headers.length > 0) {
      const categoryIndex = findColumnIndex(assetTable.headers, ['category']);
      const sourceIndex = findColumnIndex(assetTable.headers, ['source']);
      const usageIndex = findColumnIndex(assetTable.headers, ['usage']);

      for (const row of assetTable.rows) {
        const category = categoryIndex >= 0 ? row[categoryIndex] : row[0];
        const description = sourceIndex >= 0 ? row[sourceIndex] : row[1];

        if (category && description) {
          assets.push({
            category,
            description,
            suggested_query: usageIndex >= 0 && row[usageIndex] ? row[usageIndex] : undefined,
          });
        }
      }
    }

    return assets;
  }
}

// =============================================================================
// エクスポート
// =============================================================================

export type {
  ParsedBrief,
  ParseOptions,
  NgExpression,
  OkExpression,
  ColorToken,
  RequiredAsset,
} from './schemas/brief-parser-schemas';
