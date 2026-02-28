// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Component Splitter
 *
 * HTMLを意味のあるサブコンポーネントに分割する機能を提供します。
 *
 * 機能:
 * - セマンティックHTML要素の検出と分割 (header, nav, main, section, article, aside, footer)
 * - クラスパターンによる分割 (*-header, *-nav, *-card, *-item, *-list)
 * - data属性による分割 (data-component, data-section)
 * - 繰り返し構造の検出とコンポーネント化
 *
 * @module services/layout/component-splitter
 */

import { JSDOM } from 'jsdom';
import { convertHtmlToJsx } from './html-to-jsx-converter';

// ==========================================================
// 型定義
// ==========================================================

/**
 * 分割オプション
 */
export interface SplitOptions {
  /** メインコンポーネント名（デフォルト: MainComponent） */
  mainComponentName?: string;
  /** 最小要素数（デフォルト: 3）*/
  minElements?: number;
  /** 最大ネストレベル（デフォルト: 2）*/
  maxNestLevel?: number;
}

/**
 * Props定義
 */
export interface PropDefinition {
  name: string;
  type: string;
}

/**
 * サブコンポーネント
 */
export interface SubComponent {
  name: string;
  jsx: string;
  props: PropDefinition[];
}

/**
 * メインコンポーネント
 */
export interface MainComponent {
  name: string;
  jsx: string;
  imports: string[];
}

/**
 * 分割結果
 */
export interface SplitResult {
  mainComponent: MainComponent;
  subComponents: SubComponent[];
}

// ==========================================================
// 定数
// ==========================================================

/**
 * セマンティックHTML要素とコンポーネント名のマッピング
 */
const SEMANTIC_ELEMENT_MAP: Record<string, string> = {
  header: 'HeaderSection',
  nav: 'Navigation',
  main: 'MainContent',
  section: 'Section',
  article: 'Article',
  aside: 'Aside',
  footer: 'FooterSection',
};

/**
 * クラスパターンとサフィックス
 */
const CLASS_PATTERNS = [
  { pattern: /-header$/i, suffix: 'Header' },
  { pattern: /-nav$/i, suffix: 'Nav' },
  { pattern: /-card$/i, suffix: 'Card' },
  { pattern: /-item$/i, suffix: 'Item' },
  { pattern: /-list$/i, suffix: 'List' },
  { pattern: /-footer$/i, suffix: 'Footer' },
  { pattern: /-content$/i, suffix: 'Content' },
  { pattern: /-wrapper$/i, suffix: 'Wrapper' },
  { pattern: /-section$/i, suffix: 'Section' },
  { pattern: /-container$/i, suffix: 'Container' },
];

// ==========================================================
// ヘルパー関数
// ==========================================================

/**
 * 文字列をPascalCaseに変換
 */
function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/**
 * 要素の子要素数を取得（テキストノードを除く）
 */
function getElementCount(element: Element): number {
  let count = 0;
  const walk = (el: Element): void => {
    count++;
    for (const child of Array.from(el.children)) {
      walk(child);
    }
  };
  walk(element);
  return count;
}

/**
 * 要素のクラス名を取得
 */
function getClassName(element: Element): string | null {
  const classAttr = element.getAttribute('class');
  if (!classAttr) return null;
  // 最初のクラス名を返す
  return classAttr.trim().split(/\s+/)[0] || null;
}

/**
 * クラス名からコンポーネント名を推測
 */
function inferComponentNameFromClass(className: string): string | null {
  // パターンマッチング
  for (const { pattern, suffix: _suffix } of CLASS_PATTERNS) {
    if (pattern.test(className)) {
      return toPascalCase(className);
    }
  }
  // 一般的なパターン
  return toPascalCase(className);
}

/**
 * data属性からコンポーネント名を取得
 */
function getComponentNameFromDataAttr(element: Element): string | null {
  const dataComponent = element.getAttribute('data-component');
  if (dataComponent) {
    return toPascalCase(dataComponent);
  }
  const dataSection = element.getAttribute('data-section');
  if (dataSection) {
    return toPascalCase(dataSection);
  }
  return null;
}

/**
 * クラス名がパターンにマッチするか判定
 */
function matchesClassPattern(className: string): boolean {
  for (const { pattern } of CLASS_PATTERNS) {
    if (pattern.test(className)) {
      return true;
    }
  }
  return false;
}

/**
 * 要素が分割候補かどうかを判定
 */
function isSplitCandidate(
  element: Element,
  minElements: number,
  currentLevel: number,
  maxNestLevel: number
): boolean {
  // ネストレベルチェック（maxNestLevel=2の場合、level 0と1のみ分割可能）
  if (currentLevel >= maxNestLevel) {
    return false;
  }

  // セマンティック要素は要素数に関わらず候補
  const tagName = element.tagName.toLowerCase();
  if (SEMANTIC_ELEMENT_MAP[tagName]) {
    // ただし、最小要素数のチェックは適用
    const elementCount = getElementCount(element);
    return elementCount >= minElements;
  }

  // data属性は要素数に関わらず候補
  if (element.hasAttribute('data-component') || element.hasAttribute('data-section')) {
    const elementCount = getElementCount(element);
    return elementCount >= minElements;
  }

  // クラスパターン
  const className = getClassName(element);
  if (className) {
    // 要素数チェック
    const elementCount = getElementCount(element);
    if (elementCount < minElements) {
      return false;
    }

    // パターンマッチング
    if (matchesClassPattern(className)) {
      return true;
    }

    // 一般的なクラス名も候補に（ただし、複数単語で構成されるクラス名のみ）
    if (className.includes('-') || className.includes('_')) {
      return true;
    }
  }

  return false;
}

/**
 * コンポーネント名を決定
 */
function determineComponentName(element: Element): string {
  // 1. data属性を優先
  const dataName = getComponentNameFromDataAttr(element);
  if (dataName) return dataName;

  // 2. セマンティック要素名
  const tagName = element.tagName.toLowerCase();
  if (SEMANTIC_ELEMENT_MAP[tagName]) {
    return SEMANTIC_ELEMENT_MAP[tagName];
  }

  // 3. クラス名から推測
  const className = getClassName(element);
  if (className) {
    const inferred = inferComponentNameFromClass(className);
    if (inferred) return inferred;
  }

  // 4. デフォルト
  return 'Component';
}

/**
 * 繰り返し要素を検出
 */
function findRepeatingElements(parent: Element): Map<string, Element[]> {
  const repeatingMap = new Map<string, Element[]>();
  const children = Array.from(parent.children);

  for (const child of children) {
    const className = getClassName(child);
    if (className) {
      const existing = repeatingMap.get(className) || [];
      existing.push(child);
      repeatingMap.set(className, existing);
    }
  }

  // 2つ以上の同じクラスを持つ要素のみを返す
  const result = new Map<string, Element[]>();
  for (const [className, elements] of repeatingMap) {
    if (elements.length >= 2) {
      result.set(className, elements);
    }
  }

  return result;
}

/**
 * 繰り返し要素からpropsを抽出
 */
function extractPropsFromRepeatingElements(elements: Element[]): PropDefinition[] {
  const props: PropDefinition[] = [];
  const propsSet = new Set<string>();

  if (elements.length === 0) return props;

  // 最初の要素から構造を分析
  const firstElement = elements[0];
  if (!firstElement) return props;

  // 子要素のクラス名からpropsを推測
  const walkChildren = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const className = getClassName(child);
      if (className) {
        // -title, -desc, -text などのサフィックスを検出
        const match = className.match(/-(title|desc|description|text|name|image|icon|src)$/i);
        if (match && match[1]) {
          const propName = match[1].toLowerCase();
          if (!propsSet.has(propName)) {
            propsSet.add(propName);
            props.push({ name: propName, type: 'string' });
          }
        }
      }
      walkChildren(child);
    }
  };

  // h1-h6からtitleを推測
  const headings = firstElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (headings.length > 0 && !propsSet.has('title')) {
    propsSet.add('title');
    props.push({ name: 'title', type: 'string' });
  }

  // pタグからdescriptionを推測
  const paragraphs = firstElement.querySelectorAll('p');
  if (paragraphs.length > 0 && !propsSet.has('description')) {
    propsSet.add('description');
    props.push({ name: 'description', type: 'string' });
  }

  // imgタグからsrcを推測
  const images = firstElement.querySelectorAll('img');
  if (images.length > 0) {
    if (!propsSet.has('src')) {
      propsSet.add('src');
      props.push({ name: 'src', type: 'string' });
    }
    if (!propsSet.has('alt')) {
      propsSet.add('alt');
      props.push({ name: 'alt', type: 'string' });
    }
  }

  walkChildren(firstElement);

  return props;
}

/**
 * 要素からpropsを抽出
 */
function extractPropsFromElement(element: Element): PropDefinition[] {
  const props: PropDefinition[] = [];
  const propsSet = new Set<string>();

  // className props
  if (element.hasAttribute('class')) {
    propsSet.add('className');
    props.push({ name: 'className', type: 'string' });
  }

  // 子要素がある場合はchildren
  if (element.children.length > 0) {
    propsSet.add('children');
    props.push({ name: 'children', type: 'React.ReactNode' });
  }

  // imgタグからsrcを推測
  const images = element.querySelectorAll('img');
  if (images.length > 0) {
    if (!propsSet.has('src')) {
      propsSet.add('src');
      props.push({ name: 'src', type: 'string' });
    }
    if (!propsSet.has('alt')) {
      propsSet.add('alt');
      props.push({ name: 'alt', type: 'string' });
    }
  }

  // h1-h6からtitleを推測
  const headings = element.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (headings.length > 0 && !propsSet.has('title')) {
    propsSet.add('title');
    props.push({ name: 'title', type: 'string' });
  }

  // pタグからdescriptionを推測
  const paragraphs = element.querySelectorAll('p');
  if (paragraphs.length > 0 && !propsSet.has('description')) {
    propsSet.add('description');
    props.push({ name: 'description', type: 'string' });
  }

  return props;
}

/**
 * 一意なコンポーネント名を生成
 */
function generateUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let counter = 2;
  while (existingNames.has(`${baseName}${counter}`)) {
    counter++;
  }
  return `${baseName}${counter}`;
}

// ==========================================================
// 分割候補の収集
// ==========================================================

interface SplitCandidate {
  element: Element;
  name: string;
  level: number;
  isRepeating: boolean;
  repeatingElements?: Element[];
}

/**
 * 分割候補を深さ優先で収集
 */
function collectSplitCandidates(
  element: Element,
  minElements: number,
  maxNestLevel: number,
  currentLevel: number = 0,
  _parentIsSplit: boolean = false
): SplitCandidate[] {
  const candidates: SplitCandidate[] = [];

  // 繰り返し要素を検出
  const repeatingElements = findRepeatingElements(element);

  // 繰り返し要素を候補に追加
  for (const [className, elements] of repeatingElements) {
    const firstElement = elements[0];
    if (!firstElement) continue;
    const componentName = toPascalCase(className);
    candidates.push({
      element: firstElement,
      name: componentName,
      level: currentLevel,
      isRepeating: true,
      repeatingElements: elements,
    });
  }

  // 子要素を走査
  for (const child of Array.from(element.children)) {
    // 繰り返し要素として既に処理されている場合はスキップ
    const className = getClassName(child);
    if (className && repeatingElements.has(className)) {
      continue;
    }

    // 分割候補かどうか判定
    if (isSplitCandidate(child, minElements, currentLevel, maxNestLevel)) {
      const name = determineComponentName(child);
      candidates.push({
        element: child,
        name,
        level: currentLevel,
        isRepeating: false,
      });

      // 子要素も再帰的に処理（ただしネストレベルを増やす）
      // maxNestLevel=2の場合、level 0と1の分割候補を検出するため、level 1まで検索を続ける
      if (currentLevel + 1 <= maxNestLevel) {
        const childCandidates = collectSplitCandidates(
          child,
          minElements,
          maxNestLevel,
          currentLevel + 1,
          true
        );
        candidates.push(...childCandidates);
      }
    } else {
      // 分割候補でない場合も子要素を走査
      const childCandidates = collectSplitCandidates(
        child,
        minElements,
        maxNestLevel,
        currentLevel,
        false
      );
      candidates.push(...childCandidates);
    }
  }

  return candidates;
}

// ==========================================================
// メイン関数
// ==========================================================

/**
 * HTMLを意味のあるサブコンポーネントに分割する
 *
 * @param html - 分割対象のHTML文字列
 * @param options - 分割オプション
 * @returns 分割結果（メインコンポーネントとサブコンポーネント）
 *
 * @example
 * ```typescript
 * const html = `
 *   <div>
 *     <header><h1>Title</h1></header>
 *     <main><p>Content</p></main>
 *     <footer><p>Footer</p></footer>
 *   </div>
 * `;
 * const result = splitIntoComponents(html);
 * // result.subComponents には HeaderSection, MainContent, FooterSection が含まれる
 * ```
 */
export function splitIntoComponents(html: string, options?: SplitOptions): SplitResult {
  const opts = {
    mainComponentName: 'MainComponent',
    minElements: 3,
    maxNestLevel: 2,
    ...options,
  };

  // 空のHTMLの場合
  if (!html || html.trim() === '') {
    return {
      mainComponent: {
        name: opts.mainComponentName,
        jsx: '',
        imports: [],
      },
      subComponents: [],
    };
  }

  // HTMLをパース
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const body = document.body;

  // 分割候補を収集
  const candidates = collectSplitCandidates(body, opts.minElements, opts.maxNestLevel);

  // 重複を除去して一意なコンポーネント名を生成
  const subComponents: SubComponent[] = [];
  const usedNames = new Set<string>();
  const processedElements = new Set<Element>();

  for (const candidate of candidates) {
    // 既に処理された要素はスキップ
    if (processedElements.has(candidate.element)) {
      continue;
    }

    // 一意な名前を生成
    const uniqueName = generateUniqueName(candidate.name, usedNames);
    usedNames.add(uniqueName);

    // JSXを生成（独自クラス名を除去）
    const jsx = convertHtmlToJsx(candidate.element.outerHTML, {
      removeEmptyAttributes: true,
      removeProprietaryClasses: true, // dwg-*, webflow-*, framer-*, etc.を除去
    });

    // propsを抽出
    let props: PropDefinition[];
    if (candidate.isRepeating && candidate.repeatingElements) {
      props = extractPropsFromRepeatingElements(candidate.repeatingElements);
      // 繰り返し要素をすべて処理済みとしてマーク
      for (const el of candidate.repeatingElements) {
        processedElements.add(el);
      }
    } else {
      props = extractPropsFromElement(candidate.element);
      processedElements.add(candidate.element);
    }

    subComponents.push({
      name: uniqueName,
      jsx,
      props,
    });
  }

  // import文を生成
  const imports = subComponents.map(
    (comp) => `import { ${comp.name} } from './${comp.name}';`
  );

  // メインコンポーネントのJSXを生成
  // サブコンポーネントとして分割された要素をコンポーネントタグに置き換え
  let mainJsx = html;

  // 繰り返し要素のマップ構文を生成
  for (const candidate of candidates) {
    if (candidate.isRepeating && candidate.repeatingElements && candidate.repeatingElements.length > 0) {
      const componentName = generateUniqueName(candidate.name, new Set());
      const props = extractPropsFromRepeatingElements(candidate.repeatingElements);
      const propsString = props.map((p) => `${p.name}={item.${p.name}}`).join(' ');

      // 親要素を特定
      const firstElement = candidate.repeatingElements[0];
      if (!firstElement) continue;

      const parent = firstElement.parentElement;
      if (parent) {
        const mapSyntax = `{items.map((item, index) => <${componentName} key={index} ${propsString} />)}`;

        // 繰り返し要素を含む親要素内をマップ構文に置き換え
        const className = getClassName(firstElement);
        if (className) {
          // 同じクラスを持つ要素をすべてマップ構文に置き換え
          const regex = new RegExp(
            `<${firstElement.tagName.toLowerCase()}[^>]*class="[^"]*${className}[^"]*"[^>]*>[\\s\\S]*?<\\/${firstElement.tagName.toLowerCase()}>`,
            'gi'
          );
          let firstMatch = true;
          mainJsx = mainJsx.replace(regex, () => {
            if (firstMatch) {
              firstMatch = false;
              return mapSyntax;
            }
            return ''; // 2つ目以降は削除
          });
        }
      }
    }
  }

  // HTML→JSX変換（独自クラス名を除去）
  mainJsx = convertHtmlToJsx(mainJsx, {
    removeEmptyAttributes: true,
    removeProprietaryClasses: true, // dwg-*, webflow-*, framer-*, etc.を除去
  });

  return {
    mainComponent: {
      name: opts.mainComponentName,
      jsx: mainJsx,
      imports,
    },
    subComponents,
  };
}
