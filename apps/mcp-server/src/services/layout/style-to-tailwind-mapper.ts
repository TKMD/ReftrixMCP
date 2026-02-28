// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style to TailwindCSS Mapper
 *
 * インラインスタイル（CSSプロパティ）をTailwindCSSユーティリティクラスに変換するマッパー
 *
 * 機能:
 * - display系（flex, grid, block, inline, none）→ Tailwindクラス
 * - flexbox系（direction, justify, align, gap）→ Tailwindクラス
 * - spacing系（padding, margin）→ Tailwindクラス
 * - sizing系（width, height, min/max）→ Tailwindクラス
 * - color系（background-color, color）→ Tailwindクラス
 * - typography系（font-size, font-weight, text-align）→ Tailwindクラス
 * - border系（border-radius）→ Tailwindクラス
 * - position系 → Tailwindクラス
 * - opacity系 → Tailwindクラス
 * - overflow系 → Tailwindクラス
 * - z-index系 → Tailwindクラス
 * - cursor系 → Tailwindクラス
 * - pointer-events系 → Tailwindクラス
 * - user-select系 → Tailwindクラス
 *
 * @module services/layout/style-to-tailwind-mapper
 */

// ==========================================================
// 型定義
// ==========================================================

/**
 * スタイルからTailwindへの変換結果
 */
export interface StyleToTailwindResult {
  /** 変換されたTailwindクラス */
  tailwindClasses: string[];
  /** 変換できなかったスタイル */
  remainingStyles: Record<string, string>;
}

/**
 * マッパーオプション
 */
export interface MapperOptions {
  /**
   * レスポンシブブレークポイントを自動生成するか
   * trueの場合、大きな固定値を持つプロパティにレスポンシブクラスを追加
   * @default true
   */
  responsive?: boolean;
}

/**
 * スタイルオブジェクト型（キャメルケースのCSSプロパティ）
 */
export type StyleObject = Record<string, string>;

// ==========================================================
// マッピング定義
// ==========================================================

/**
 * displayプロパティのマッピング
 */
const DISPLAY_MAP: Record<string, string> = {
  flex: 'flex',
  grid: 'grid',
  block: 'block',
  inline: 'inline',
  'inline-block': 'inline-block',
  'inline-flex': 'inline-flex',
  'inline-grid': 'inline-grid',
  none: 'hidden',
  contents: 'contents',
};

/**
 * flexDirectionプロパティのマッピング
 */
const FLEX_DIRECTION_MAP: Record<string, string> = {
  row: 'flex-row',
  'row-reverse': 'flex-row-reverse',
  column: 'flex-col',
  'column-reverse': 'flex-col-reverse',
};

/**
 * justifyContentプロパティのマッピング
 */
const JUSTIFY_CONTENT_MAP: Record<string, string> = {
  'flex-start': 'justify-start',
  start: 'justify-start',
  center: 'justify-center',
  'flex-end': 'justify-end',
  end: 'justify-end',
  'space-between': 'justify-between',
  'space-around': 'justify-around',
  'space-evenly': 'justify-evenly',
  stretch: 'justify-stretch',
};

/**
 * alignItemsプロパティのマッピング
 */
const ALIGN_ITEMS_MAP: Record<string, string> = {
  'flex-start': 'items-start',
  start: 'items-start',
  center: 'items-center',
  'flex-end': 'items-end',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
};

/**
 * flexWrapプロパティのマッピング
 */
const FLEX_WRAP_MAP: Record<string, string> = {
  wrap: 'flex-wrap',
  nowrap: 'flex-nowrap',
  'wrap-reverse': 'flex-wrap-reverse',
};

/**
 * positionプロパティのマッピング
 */
const POSITION_MAP: Record<string, string> = {
  static: 'static',
  relative: 'relative',
  absolute: 'absolute',
  fixed: 'fixed',
  sticky: 'sticky',
};

/**
 * overflowプロパティのマッピング
 */
const OVERFLOW_MAP: Record<string, string> = {
  auto: 'overflow-auto',
  hidden: 'overflow-hidden',
  visible: 'overflow-visible',
  scroll: 'overflow-scroll',
  clip: 'overflow-clip',
};

/**
 * textAlignプロパティのマッピング
 */
const TEXT_ALIGN_MAP: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
  justify: 'text-justify',
  start: 'text-start',
  end: 'text-end',
};

/**
 * fontWeightプロパティのマッピング
 */
const FONT_WEIGHT_MAP: Record<string, string> = {
  '100': 'font-thin',
  '200': 'font-extralight',
  '300': 'font-light',
  '400': 'font-normal',
  normal: 'font-normal',
  '500': 'font-medium',
  '600': 'font-semibold',
  '700': 'font-bold',
  bold: 'font-bold',
  '800': 'font-extrabold',
  '900': 'font-black',
};

/**
 * cursorプロパティのマッピング
 */
const CURSOR_MAP: Record<string, string> = {
  auto: 'cursor-auto',
  default: 'cursor-default',
  pointer: 'cursor-pointer',
  wait: 'cursor-wait',
  text: 'cursor-text',
  move: 'cursor-move',
  help: 'cursor-help',
  'not-allowed': 'cursor-not-allowed',
  none: 'cursor-none',
  'context-menu': 'cursor-context-menu',
  progress: 'cursor-progress',
  cell: 'cursor-cell',
  crosshair: 'cursor-crosshair',
  'vertical-text': 'cursor-vertical-text',
  alias: 'cursor-alias',
  copy: 'cursor-copy',
  'no-drop': 'cursor-no-drop',
  grab: 'cursor-grab',
  grabbing: 'cursor-grabbing',
  'all-scroll': 'cursor-all-scroll',
  'col-resize': 'cursor-col-resize',
  'row-resize': 'cursor-row-resize',
  'n-resize': 'cursor-n-resize',
  'e-resize': 'cursor-e-resize',
  's-resize': 'cursor-s-resize',
  'w-resize': 'cursor-w-resize',
  'ne-resize': 'cursor-ne-resize',
  'nw-resize': 'cursor-nw-resize',
  'se-resize': 'cursor-se-resize',
  'sw-resize': 'cursor-sw-resize',
  'ew-resize': 'cursor-ew-resize',
  'ns-resize': 'cursor-ns-resize',
  'nesw-resize': 'cursor-nesw-resize',
  'nwse-resize': 'cursor-nwse-resize',
  'zoom-in': 'cursor-zoom-in',
  'zoom-out': 'cursor-zoom-out',
};

/**
 * pointerEventsプロパティのマッピング
 */
const POINTER_EVENTS_MAP: Record<string, string> = {
  none: 'pointer-events-none',
  auto: 'pointer-events-auto',
};

/**
 * userSelectプロパティのマッピング
 */
const USER_SELECT_MAP: Record<string, string> = {
  none: 'select-none',
  text: 'select-text',
  all: 'select-all',
  auto: 'select-auto',
};

/**
 * 色の基本マッピング
 */
const COLOR_MAP: Record<string, string> = {
  transparent: 'transparent',
  current: 'current',
  currentColor: 'current',
  black: 'black',
  white: 'white',
  inherit: 'inherit',
};

/**
 * HEX色コード → 色名のマッピング
 * #fff, #ffffff → white
 * #000, #000000 → black
 */
const HEX_COLOR_MAP: Record<string, string> = {
  // 白色
  '#fff': 'white',
  '#ffffff': 'white',
  '#FFF': 'white',
  '#FFFFFF': 'white',
  // 黒色
  '#000': 'black',
  '#000000': 'black',
  // 透明
  '#0000': 'transparent',
  '#00000000': 'transparent',
};

/**
 * lineHeightマッピング
 */
const LINE_HEIGHT_MAP: Record<string, string> = {
  '1': 'leading-none',
  '1.25': 'leading-tight',
  '1.375': 'leading-snug',
  '1.5': 'leading-normal',
  '1.625': 'leading-relaxed',
  '2': 'leading-loose',
  // 数値単位なし（remへの変換は複雑なため、主要な値のみサポート）
};

/**
 * maxWidthブレークポイントマッピング（px → Tailwindクラス）
 */
const MAX_WIDTH_BREAKPOINT_MAP: Record<number, string> = {
  0: 'max-w-0',
  256: 'max-w-xs', // 16rem
  288: 'max-w-sm', // 18rem
  320: 'max-w-md', // 20rem
  384: 'max-w-lg', // 24rem
  448: 'max-w-xl', // 28rem
  512: 'max-w-2xl', // 32rem
  576: 'max-w-3xl', // 36rem
  672: 'max-w-4xl', // 42rem
  768: 'max-w-5xl', // 48rem
  896: 'max-w-6xl', // 56rem
  1024: 'max-w-7xl', // 64rem - 実際のTailwindは1280pxだが近似値
  1152: 'max-w-7xl', // 72rem
  1280: 'max-w-7xl', // 80rem - Tailwindのmax-w-7xl (80rem = 1280px)
};

/**
 * Tailwind spacing scale（0-96）
 * キー: ピクセル値、値: Tailwindクラスの数値部分
 */
const SPACING_SCALE: Record<number, string> = {
  0: '0',
  1: 'px', // 1px
  2: '0.5', // 2px = 0.125rem
  4: '1', // 4px = 0.25rem
  6: '1.5', // 6px = 0.375rem
  8: '2', // 8px = 0.5rem
  10: '2.5', // 10px = 0.625rem
  12: '3', // 12px = 0.75rem
  14: '3.5', // 14px = 0.875rem
  16: '4', // 16px = 1rem
  20: '5', // 20px = 1.25rem
  24: '6', // 24px = 1.5rem
  28: '7', // 28px = 1.75rem
  32: '8', // 32px = 2rem
  36: '9', // 36px = 2.25rem
  40: '10', // 40px = 2.5rem
  44: '11', // 44px = 2.75rem
  48: '12', // 48px = 3rem
  56: '14', // 56px = 3.5rem
  64: '16', // 64px = 4rem
  72: '18', // 72px = 4.5rem
  80: '20', // 80px = 5rem
  96: '24', // 96px = 6rem
  112: '28', // 112px = 7rem
  128: '32', // 128px = 8rem
  144: '36', // 144px = 9rem
  160: '40', // 160px = 10rem
  176: '44', // 176px = 11rem
  192: '48', // 192px = 12rem
  208: '52', // 208px = 13rem
  224: '56', // 224px = 14rem
  240: '60', // 240px = 15rem
  256: '64', // 256px = 16rem
  288: '72', // 288px = 18rem
  320: '80', // 320px = 20rem
  384: '96', // 384px = 24rem
};

/**
 * fontSizeマッピング（px→Tailwindクラス）
 */
const FONT_SIZE_MAP: Record<number, string> = {
  12: 'text-xs', // 0.75rem
  14: 'text-sm', // 0.875rem
  16: 'text-base', // 1rem
  18: 'text-lg', // 1.125rem
  20: 'text-xl', // 1.25rem
  24: 'text-2xl', // 1.5rem
  30: 'text-3xl', // 1.875rem
  36: 'text-4xl', // 2.25rem
  48: 'text-5xl', // 3rem
  60: 'text-6xl', // 3.75rem
  72: 'text-7xl', // 4.5rem
  96: 'text-8xl', // 6rem
  128: 'text-9xl', // 8rem
};

/**
 * fontSizeマッピング（rem→Tailwindクラス）
 */
const FONT_SIZE_REM_MAP: Record<string, string> = {
  '0.75': 'text-xs',
  '0.875': 'text-sm',
  '1': 'text-base',
  '1.125': 'text-lg',
  '1.25': 'text-xl',
  '1.5': 'text-2xl',
  '1.875': 'text-3xl',
  '2.25': 'text-4xl',
  '3': 'text-5xl',
  '3.75': 'text-6xl',
  '4.5': 'text-7xl',
  '6': 'text-8xl',
  '8': 'text-9xl',
};

/**
 * borderRadiusマッピング（px→Tailwindクラス）
 */
const BORDER_RADIUS_MAP: Record<number, string> = {
  0: 'rounded-none',
  2: 'rounded-sm', // 0.125rem
  4: 'rounded', // 0.25rem
  6: 'rounded-md', // 0.375rem
  8: 'rounded-lg', // 0.5rem
  12: 'rounded-xl', // 0.75rem
  16: 'rounded-2xl', // 1rem
  24: 'rounded-3xl', // 1.5rem
  9999: 'rounded-full',
};

/**
 * opacityマッピング
 */
const OPACITY_MAP: Record<string, string> = {
  '0': 'opacity-0',
  '0.05': 'opacity-5',
  '0.1': 'opacity-10',
  '0.15': 'opacity-15',
  '0.2': 'opacity-20',
  '0.25': 'opacity-25',
  '0.3': 'opacity-30',
  '0.35': 'opacity-35',
  '0.4': 'opacity-40',
  '0.45': 'opacity-45',
  '0.5': 'opacity-50',
  '0.55': 'opacity-55',
  '0.6': 'opacity-60',
  '0.65': 'opacity-65',
  '0.7': 'opacity-70',
  '0.75': 'opacity-75',
  '0.8': 'opacity-80',
  '0.85': 'opacity-85',
  '0.9': 'opacity-90',
  '0.95': 'opacity-95',
  '1': 'opacity-100',
};

/**
 * z-indexマッピング
 */
const Z_INDEX_MAP: Record<string, string> = {
  '0': 'z-0',
  '10': 'z-10',
  '20': 'z-20',
  '30': 'z-30',
  '40': 'z-40',
  '50': 'z-50',
  auto: 'z-auto',
};

/**
 * widthのパーセンテージマッピング
 */
const WIDTH_PERCENTAGE_MAP: Record<string, string> = {
  '100%': 'w-full',
  '50%': 'w-1/2',
  '33.333333%': 'w-1/3',
  '33.33%': 'w-1/3',
  '66.666667%': 'w-2/3',
  '66.67%': 'w-2/3',
  '25%': 'w-1/4',
  '75%': 'w-3/4',
  '20%': 'w-1/5',
  '40%': 'w-2/5',
  '60%': 'w-3/5',
  '80%': 'w-4/5',
  '16.666667%': 'w-1/6',
  '83.333333%': 'w-5/6',
};

// ==========================================================
// レスポンシブブレークポイント関連
// TailwindCSS v4.1 ブレークポイント:
// sm: 640px, md: 768px, lg: 1024px, xl: 1280px, 2xl: 1536px
// ==========================================================

/**
 * 大きな固定幅をmax-w + w-fullに変換するマッピング
 * ピクセル値 → max-wクラス
 */
const LARGE_WIDTH_TO_MAX_W_MAP: Record<number, string> = {
  640: 'max-w-2xl', // sm相当
  768: 'max-w-3xl', // md相当
  896: 'max-w-4xl',
  1024: 'max-w-5xl', // lg相当
  1152: 'max-w-6xl',
  1200: 'max-w-7xl',
  1280: 'max-w-7xl', // xl相当
  1536: 'max-w-screen-2xl', // 2xl相当
};

/**
 * 大きなfontSizeのレスポンシブマッピング
 * 元のpx値 → [mobile, md, lg]のクラス配列
 */
const LARGE_FONT_SIZE_RESPONSIVE_MAP: Record<
  number,
  { mobile: string; md: string; lg: string }
> = {
  // 36px → text-2xl / text-3xl / text-4xl
  36: { mobile: 'text-2xl', md: 'text-3xl', lg: 'text-4xl' },
  // 48px → text-3xl / text-4xl / text-5xl
  48: { mobile: 'text-3xl', md: 'text-4xl', lg: 'text-5xl' },
  // 60px → text-4xl / text-5xl / text-6xl
  60: { mobile: 'text-4xl', md: 'text-5xl', lg: 'text-6xl' },
  // 72px → text-5xl / text-6xl / text-7xl
  72: { mobile: 'text-5xl', md: 'text-6xl', lg: 'text-7xl' },
  // 96px → text-6xl / text-7xl / text-8xl
  96: { mobile: 'text-6xl', md: 'text-7xl', lg: 'text-8xl' },
  // 128px → text-7xl / text-8xl / text-9xl
  128: { mobile: 'text-7xl', md: 'text-8xl', lg: 'text-9xl' },
};

/**
 * 大きなpaddingのレスポンシブマッピング
 * 元のpx値 → [mobile, md, lg]のクラス配列
 */
const LARGE_PADDING_RESPONSIVE_MAP: Record<
  number,
  { mobile: string; md: string; lg: string }
> = {
  // 32px → p-4 / p-6 / p-8
  32: { mobile: 'p-4', md: 'p-6', lg: 'p-8' },
  // 40px → p-4 / p-8 / p-10
  40: { mobile: 'p-4', md: 'p-8', lg: 'p-10' },
  // 48px → p-4 / p-8 / p-12
  48: { mobile: 'p-4', md: 'p-8', lg: 'p-12' },
  // 56px → p-5 / p-10 / p-14
  56: { mobile: 'p-5', md: 'p-10', lg: 'p-14' },
  // 64px → p-6 / p-12 / p-16
  64: { mobile: 'p-6', md: 'p-12', lg: 'p-16' },
  // 80px → p-6 / p-14 / p-20
  80: { mobile: 'p-6', md: 'p-14', lg: 'p-20' },
  // 96px → p-8 / p-16 / p-24
  96: { mobile: 'p-8', md: 'p-16', lg: 'p-24' },
};

/**
 * レスポンシブ変換のしきい値（これ以上の値でレスポンシブ変換を適用）
 */
const RESPONSIVE_THRESHOLDS = {
  /** paddingのしきい値（px） - これ以上でレスポンシブ変換 */
  padding: 32,
  /** fontSizeのしきい値（px） - これ以上でレスポンシブ変換 */
  fontSize: 36,
  /** widthのしきい値（px） - これ以上でmax-w + w-fullに変換 */
  width: 640,
};

/**
 * heightのパーセンテージマッピング
 */
const HEIGHT_PERCENTAGE_MAP: Record<string, string> = {
  '100%': 'h-full',
  '50%': 'h-1/2',
  '33.333333%': 'h-1/3',
  '66.666667%': 'h-2/3',
  '25%': 'h-1/4',
  '75%': 'h-3/4',
  '20%': 'h-1/5',
  '40%': 'h-2/5',
  '60%': 'h-3/5',
  '80%': 'h-4/5',
  '16.666667%': 'h-1/6',
  '83.333333%': 'h-5/6',
};

// ==========================================================
// ヘルパー関数
// ==========================================================

/**
 * CSS変数またはcalc()を含むかチェック
 */
function containsCssFunction(value: string): boolean {
  return value.includes('var(') || value.includes('calc(') || value.includes('clamp(');
}

/**
 * ピクセル値を数値に変換
 */
function parsePixelValue(value: string): number | null {
  // "0"の場合
  if (value === '0') {
    return 0;
  }

  // "16px"形式
  const pxMatch = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (pxMatch && pxMatch[1] !== undefined) {
    return parseFloat(pxMatch[1]);
  }

  // "1rem"形式（1rem = 16px）
  const remMatch = value.match(/^(-?\d+(?:\.\d+)?)rem$/);
  if (remMatch && remMatch[1] !== undefined) {
    return parseFloat(remMatch[1]) * 16;
  }

  return null;
}

/**
 * rem値を文字列として取得（小数点対応）
 */
function parseRemValue(value: string): string | null {
  const remMatch = value.match(/^(-?\d+(?:\.\d+)?)rem$/);
  if (remMatch && remMatch[1] !== undefined) {
    return remMatch[1];
  }
  return null;
}

/**
 * スペーシング値をTailwindクラスの数値部分に変換
 */
function convertSpacingValue(value: string): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // autoの場合
  if (value === 'auto') {
    return 'auto';
  }

  // "0"の場合
  if (value === '0') {
    return '0';
  }

  const pixels = parsePixelValue(value);
  if (pixels === null) {
    return null;
  }

  const tailwindValue = SPACING_SCALE[pixels];
  if (tailwindValue !== undefined) {
    return tailwindValue;
  }

  return null;
}

/**
 * displayプロパティを変換
 */
function convertDisplay(value: string): string | null {
  return DISPLAY_MAP[value] || null;
}

/**
 * flexDirectionプロパティを変換
 */
function convertFlexDirection(value: string): string | null {
  return FLEX_DIRECTION_MAP[value] || null;
}

/**
 * justifyContentプロパティを変換
 */
function convertJustifyContent(value: string): string | null {
  return JUSTIFY_CONTENT_MAP[value] || null;
}

/**
 * alignItemsプロパティを変換
 */
function convertAlignItems(value: string): string | null {
  return ALIGN_ITEMS_MAP[value] || null;
}

/**
 * flexWrapプロパティを変換
 */
function convertFlexWrap(value: string): string | null {
  return FLEX_WRAP_MAP[value] || null;
}

/**
 * gapプロパティを変換
 */
function convertGap(value: string, prefix: string = 'gap'): string | null {
  const spacingValue = convertSpacingValue(value);
  if (spacingValue !== null) {
    return `${prefix}-${spacingValue}`;
  }
  return null;
}

/**
 * grid-template-columnsプロパティを変換
 *
 * サポートするパターン:
 * - repeat(N, 1fr) → grid-cols-N (N = 1-12)
 * - repeat(N, minmax(0, 1fr)) → grid-cols-N (N = 1-12)
 * - none → grid-cols-none
 * - subgrid → grid-cols-subgrid
 *
 * @param value - grid-template-columnsの値
 * @returns Tailwindクラスまたはnull
 */
function convertGridTemplateColumns(value: string): string | null {
  const normalizedValue = value.trim().toLowerCase();

  // noneの場合
  if (normalizedValue === 'none') {
    return 'grid-cols-none';
  }

  // subgridの場合
  if (normalizedValue === 'subgrid') {
    return 'grid-cols-subgrid';
  }

  // repeat(N, 1fr) パターン
  const repeatMatch = normalizedValue.match(/^repeat\s*\(\s*(\d+)\s*,\s*(1fr|minmax\s*\(\s*0\s*,\s*1fr\s*\))\s*\)$/);
  if (repeatMatch && repeatMatch[1]) {
    const count = parseInt(repeatMatch[1], 10);
    // Tailwindは1-12列をサポート
    if (count >= 1 && count <= 12) {
      return `grid-cols-${count}`;
    }
  }

  // 1fr 1fr 1fr... パターン（スペース区切りの1fr）
  const frParts = normalizedValue.split(/\s+/).filter(Boolean);
  if (frParts.every((part) => part === '1fr')) {
    const count = frParts.length;
    if (count >= 1 && count <= 12) {
      return `grid-cols-${count}`;
    }
  }

  return null;
}

/**
 * grid-template-rowsプロパティを変換
 *
 * サポートするパターン:
 * - repeat(N, 1fr) → grid-rows-N (N = 1-12)
 * - repeat(N, minmax(0, 1fr)) → grid-rows-N (N = 1-12)
 * - none → grid-rows-none
 * - subgrid → grid-rows-subgrid
 *
 * @param value - grid-template-rowsの値
 * @returns Tailwindクラスまたはnull
 */
function convertGridTemplateRows(value: string): string | null {
  const normalizedValue = value.trim().toLowerCase();

  // noneの場合
  if (normalizedValue === 'none') {
    return 'grid-rows-none';
  }

  // subgridの場合
  if (normalizedValue === 'subgrid') {
    return 'grid-rows-subgrid';
  }

  // repeat(N, 1fr) パターン
  const repeatMatch = normalizedValue.match(/^repeat\s*\(\s*(\d+)\s*,\s*(1fr|minmax\s*\(\s*0\s*,\s*1fr\s*\))\s*\)$/);
  if (repeatMatch && repeatMatch[1]) {
    const count = parseInt(repeatMatch[1], 10);
    // Tailwindは1-12行をサポート
    if (count >= 1 && count <= 12) {
      return `grid-rows-${count}`;
    }
  }

  // 1fr 1fr 1fr... パターン（スペース区切りの1fr）
  const frParts = normalizedValue.split(/\s+/).filter(Boolean);
  if (frParts.every((part) => part === '1fr')) {
    const count = frParts.length;
    if (count >= 1 && count <= 12) {
      return `grid-rows-${count}`;
    }
  }

  return null;
}

/**
 * padding/marginプロパティを変換
 */
function convertSpacing(
  value: string,
  prefix: string
): string | null {
  const spacingValue = convertSpacingValue(value);
  if (spacingValue !== null) {
    return `${prefix}-${spacingValue}`;
  }
  return null;
}

/**
 * widthプロパティを変換
 */
function convertWidth(value: string, prefix: string = 'w'): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // 特殊な値
  if (value === '0') return `${prefix}-0`;
  if (value === 'auto') return `${prefix}-auto`;
  if (value === 'fit-content') return `${prefix}-fit`;
  if (value === 'max-content') return `${prefix}-max`;
  if (value === 'min-content') return `${prefix}-min`;
  if (value === '100vw') return `${prefix}-screen`;
  if (value === '100dvw') return `${prefix}-dvw`;
  if (value === '100svw') return `${prefix}-svw`;
  if (value === '100lvw') return `${prefix}-lvw`;

  // パーセンテージ
  const percentageMap = prefix === 'w' ? WIDTH_PERCENTAGE_MAP : HEIGHT_PERCENTAGE_MAP;
  if (percentageMap[value]) {
    return percentageMap[value];
  }

  // ピクセル値
  const pixels = parsePixelValue(value);
  if (pixels !== null && SPACING_SCALE[pixels] !== undefined) {
    return `${prefix}-${SPACING_SCALE[pixels]}`;
  }

  return null;
}

/**
 * heightプロパティを変換
 */
function convertHeight(value: string, prefix: string = 'h'): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // 特殊な値
  if (value === '0') return `${prefix}-0`;
  if (value === 'auto') return `${prefix}-auto`;
  if (value === 'fit-content') return `${prefix}-fit`;
  if (value === 'max-content') return `${prefix}-max`;
  if (value === 'min-content') return `${prefix}-min`;
  if (value === '100vh') return `${prefix}-screen`;
  if (value === '100dvh') return `${prefix}-dvh`;
  if (value === '100svh') return `${prefix}-svh`;
  if (value === '100lvh') return `${prefix}-lvh`;

  // パーセンテージ
  const percentageMap = HEIGHT_PERCENTAGE_MAP;
  const percentValue = percentageMap[value];
  if (percentValue) {
    return percentValue.replace('h-', `${prefix}-`);
  }

  // ピクセル値
  const pixels = parsePixelValue(value);
  if (pixels !== null && SPACING_SCALE[pixels] !== undefined) {
    return `${prefix}-${SPACING_SCALE[pixels]}`;
  }

  return null;
}

/**
 * min/max width/heightプロパティを変換
 */
function convertMinMaxSize(
  value: string,
  prefix: 'min-w' | 'max-w' | 'min-h' | 'max-h'
): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // 特殊な値
  if (value === '0') return `${prefix}-0`;
  if (value === '100%') return `${prefix}-full`;
  if (value === '100vh') return `${prefix}-screen`;
  if (value === '100dvh') return `${prefix}-dvh`;
  if (value === 'none') return `${prefix}-none`;
  if (value === 'fit-content') return `${prefix}-fit`;
  if (value === 'max-content') return `${prefix}-max`;
  if (value === 'min-content') return `${prefix}-min`;

  // ピクセル値
  const pixels = parsePixelValue(value);
  if (pixels !== null) {
    // max-widthの場合、ブレークポイントマッピングを優先
    if (prefix === 'max-w' && MAX_WIDTH_BREAKPOINT_MAP[pixels] !== undefined) {
      return MAX_WIDTH_BREAKPOINT_MAP[pixels];
    }

    // 標準スペーシングスケール
    if (SPACING_SCALE[pixels] !== undefined) {
      return `${prefix}-${SPACING_SCALE[pixels]}`;
    }
  }

  return null;
}

/**
 * HEX色コードを正規化して色名に変換
 */
function normalizeHexColor(value: string): string | null {
  // 小文字に正規化
  const normalized = value.toLowerCase();

  // HEXマッピングを確認
  if (HEX_COLOR_MAP[normalized]) {
    return HEX_COLOR_MAP[normalized];
  }

  // 大文字版も確認
  if (HEX_COLOR_MAP[value]) {
    return HEX_COLOR_MAP[value];
  }

  return null;
}

/**
 * backgroundColorプロパティを変換
 */
function convertBackgroundColor(value: string): string | null {
  // CSS変数を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // まずCOLOR_MAPを確認
  const colorName = COLOR_MAP[value];
  if (colorName) {
    return `bg-${colorName}`;
  }

  // HEX色コードを確認
  if (value.startsWith('#')) {
    const hexColorName = normalizeHexColor(value);
    if (hexColorName) {
      return `bg-${hexColorName}`;
    }
    // 不明なHEX色は変換不可
    return null;
  }

  // rgb, hsl等は変換不可
  if (
    value.startsWith('rgb') ||
    value.startsWith('hsl') ||
    value.startsWith('oklch')
  ) {
    return null;
  }

  return null;
}

/**
 * colorプロパティを変換
 */
function convertTextColor(value: string): string | null {
  // CSS変数を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // まずCOLOR_MAPを確認
  const colorName = COLOR_MAP[value];
  if (colorName) {
    return `text-${colorName}`;
  }

  // HEX色コードを確認
  if (value.startsWith('#')) {
    const hexColorName = normalizeHexColor(value);
    if (hexColorName) {
      return `text-${hexColorName}`;
    }
    // 不明なHEX色は変換不可
    return null;
  }

  // rgb, hsl等は変換不可
  if (
    value.startsWith('rgb') ||
    value.startsWith('hsl') ||
    value.startsWith('oklch')
  ) {
    return null;
  }

  return null;
}

/**
 * lineHeightプロパティを変換
 */
function convertLineHeight(value: string): string | null {
  // CSS変数を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // 数値（単位なし）の場合
  if (LINE_HEIGHT_MAP[value]) {
    return LINE_HEIGHT_MAP[value];
  }

  return null;
}

/**
 * fontSizeプロパティを変換
 */
function convertFontSize(value: string): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // ピクセル値
  const pixels = parsePixelValue(value);
  if (pixels !== null && FONT_SIZE_MAP[pixels]) {
    return FONT_SIZE_MAP[pixels];
  }

  // rem値
  const remValue = parseRemValue(value);
  if (remValue !== null && FONT_SIZE_REM_MAP[remValue]) {
    return FONT_SIZE_REM_MAP[remValue];
  }

  return null;
}

/**
 * fontWeightプロパティを変換
 */
function convertFontWeight(value: string): string | null {
  return FONT_WEIGHT_MAP[value] || null;
}

/**
 * textAlignプロパティを変換
 */
function convertTextAlign(value: string): string | null {
  return TEXT_ALIGN_MAP[value] || null;
}

/**
 * borderRadiusプロパティを変換
 */
function convertBorderRadius(value: string): string | null {
  // CSS変数やcalc()を含む場合は変換不可
  if (containsCssFunction(value)) {
    return null;
  }

  // 50%（円形）
  if (value === '50%') {
    return 'rounded-full';
  }

  // "0"の場合
  if (value === '0') {
    return 'rounded-none';
  }

  // ピクセル値
  const pixels = parsePixelValue(value);
  if (pixels !== null && BORDER_RADIUS_MAP[pixels]) {
    return BORDER_RADIUS_MAP[pixels];
  }

  return null;
}

/**
 * positionプロパティを変換
 */
function convertPosition(value: string): string | null {
  return POSITION_MAP[value] || null;
}

/**
 * opacityプロパティを変換
 */
function convertOpacity(value: string): string | null {
  return OPACITY_MAP[value] || null;
}

/**
 * overflowプロパティを変換
 */
function convertOverflow(value: string, axis: '' | '-x' | '-y' = ''): string | null {
  const baseClass = OVERFLOW_MAP[value];
  if (baseClass) {
    // overflow-hidden → overflow-y-hidden
    return baseClass.replace('overflow', `overflow${axis}`);
  }
  return null;
}

/**
 * zIndexプロパティを変換
 */
function convertZIndex(value: string): string | null {
  return Z_INDEX_MAP[value] || null;
}

/**
 * cursorプロパティを変換
 */
function convertCursor(value: string): string | null {
  return CURSOR_MAP[value] || null;
}

/**
 * pointerEventsプロパティを変換
 */
function convertPointerEvents(value: string): string | null {
  return POINTER_EVENTS_MAP[value] || null;
}

/**
 * userSelectプロパティを変換
 */
function convertUserSelect(value: string): string | null {
  return USER_SELECT_MAP[value] || null;
}

// ==========================================================
// レスポンシブ変換ヘルパー関数
// ==========================================================

/**
 * 大きな固定幅をmax-w + w-fullに変換（レスポンシブ対応）
 * @param pixels - ピクセル値
 * @returns 変換されたクラス配列、または null
 */
function convertLargeWidthResponsive(pixels: number): string[] | null {
  if (pixels < RESPONSIVE_THRESHOLDS.width) {
    return null;
  }

  // 最も近いmax-wクラスを見つける
  const breakpoints = Object.keys(LARGE_WIDTH_TO_MAX_W_MAP)
    .map(Number)
    .sort((a, b) => a - b);

  let maxWClass = 'max-w-7xl'; // デフォルト

  for (const bp of breakpoints) {
    if (pixels <= bp) {
      maxWClass = LARGE_WIDTH_TO_MAX_W_MAP[bp] ?? 'max-w-7xl';
      break;
    }
  }

  // 最大値を超えている場合は最大のクラスを使用
  if (pixels > breakpoints[breakpoints.length - 1]!) {
    maxWClass = LARGE_WIDTH_TO_MAX_W_MAP[breakpoints[breakpoints.length - 1]!] ?? 'max-w-7xl';
  }

  return [maxWClass, 'w-full'];
}

/**
 * 大きなfontSizeをレスポンシブクラスに変換
 * @param pixels - ピクセル値
 * @returns 変換されたクラス配列、または null
 */
function convertLargeFontSizeResponsive(pixels: number): string[] | null {
  if (pixels < RESPONSIVE_THRESHOLDS.fontSize) {
    return null;
  }

  // 最も近いマッピングを見つける
  const sizes = Object.keys(LARGE_FONT_SIZE_RESPONSIVE_MAP)
    .map(Number)
    .sort((a, b) => a - b);

  let mapping = LARGE_FONT_SIZE_RESPONSIVE_MAP[sizes[0]!];

  for (const size of sizes) {
    if (pixels <= size) {
      mapping = LARGE_FONT_SIZE_RESPONSIVE_MAP[size];
      break;
    }
  }

  // 最大値を超えている場合は最大のマッピングを使用
  if (pixels > sizes[sizes.length - 1]!) {
    mapping = LARGE_FONT_SIZE_RESPONSIVE_MAP[sizes[sizes.length - 1]!];
  }

  if (!mapping) {
    return null;
  }

  return [mapping.mobile, `md:${mapping.md}`, `lg:${mapping.lg}`];
}

/**
 * 大きなpaddingをレスポンシブクラスに変換
 * @param pixels - ピクセル値
 * @param prefix - プレフィックス（p, pt, pb, pl, pr, px, py）
 * @returns 変換されたクラス配列、または null
 */
function convertLargePaddingResponsive(
  pixels: number,
  prefix: string = 'p'
): string[] | null {
  if (pixels < RESPONSIVE_THRESHOLDS.padding) {
    return null;
  }

  // 最も近いマッピングを見つける
  const sizes = Object.keys(LARGE_PADDING_RESPONSIVE_MAP)
    .map(Number)
    .sort((a, b) => a - b);

  let mapping = LARGE_PADDING_RESPONSIVE_MAP[sizes[0]!];

  for (const size of sizes) {
    if (pixels <= size) {
      mapping = LARGE_PADDING_RESPONSIVE_MAP[size];
      break;
    }
  }

  // 最大値を超えている場合は最大のマッピングを使用
  if (pixels > sizes[sizes.length - 1]!) {
    mapping = LARGE_PADDING_RESPONSIVE_MAP[sizes[sizes.length - 1]!];
  }

  if (!mapping) {
    return null;
  }

  // プレフィックスを適用（p → pt, pb, px, py等）
  const mobileClass = mapping.mobile.replace(/^p-/, `${prefix}-`);
  const mdClass = mapping.md.replace(/^p-/, `${prefix}-`);
  const lgClass = mapping.lg.replace(/^p-/, `${prefix}-`);

  return [mobileClass, `md:${mdClass}`, `lg:${lgClass}`];
}

/**
 * flexDirection: rowをモバイルファーストに変換
 * @returns 変換されたクラス配列
 */
function convertFlexDirectionResponsive(): string[] {
  return ['flex-col', 'md:flex-row'];
}

// ==========================================================
// メイン関数
// ==========================================================

/**
 * スタイルオブジェクトをTailwindCSSクラスに変換する
 *
 * @param styles - 変換するスタイルオブジェクト（キャメルケースのCSSプロパティ）
 * @param options - 変換オプション（レスポンシブ等）
 * @returns 変換されたTailwindクラスと残りのスタイル
 *
 * @example
 * ```typescript
 * const result = mapStyleToTailwind({
 *   display: 'flex',
 *   flexDirection: 'column',
 *   justifyContent: 'center',
 *   padding: '16px',
 * });
 * // result.tailwindClasses = ['flex', 'flex-col', 'justify-center', 'p-4']
 * // result.remainingStyles = {}
 *
 * // レスポンシブ変換（デフォルト有効）
 * const result2 = mapStyleToTailwind({
 *   width: '1200px',
 *   padding: '40px',
 *   fontSize: '48px',
 *   flexDirection: 'row',
 * }, { responsive: true });
 * // result2.tailwindClasses = [
 * //   'max-w-7xl', 'w-full',
 * //   'p-4', 'md:p-8', 'lg:p-10',
 * //   'text-3xl', 'md:text-4xl', 'lg:text-5xl',
 * //   'flex-col', 'md:flex-row'
 * // ]
 * ```
 */
export function mapStyleToTailwind(
  styles: StyleObject,
  options: MapperOptions = {}
): StyleToTailwindResult {
  // デフォルトはfalse（後方互換性）、layout.generate_codeツールからはtrue指定される
  const { responsive = false } = options;

  const tailwindClasses: string[] = [];
  const remainingStyles: Record<string, string> = {};

  for (const [property, value] of Object.entries(styles)) {
    let converted: string | null = null;
    let responsiveClasses: string[] | null = null;

    switch (property) {
      // display系
      case 'display':
        converted = convertDisplay(value);
        break;

      // flexbox系
      case 'flexDirection':
        // レスポンシブ対応: row → flex-col md:flex-row
        if (responsive && value === 'row') {
          responsiveClasses = convertFlexDirectionResponsive();
        } else {
          converted = convertFlexDirection(value);
        }
        break;
      case 'justifyContent':
        converted = convertJustifyContent(value);
        break;
      case 'alignItems':
        converted = convertAlignItems(value);
        break;
      case 'flexWrap':
        converted = convertFlexWrap(value);
        break;
      case 'gap':
        converted = convertGap(value);
        break;
      case 'rowGap':
        converted = convertGap(value, 'gap-y');
        break;
      case 'columnGap':
        converted = convertGap(value, 'gap-x');
        break;

      // grid系
      case 'gridTemplateColumns':
        converted = convertGridTemplateColumns(value);
        break;
      case 'gridTemplateRows':
        converted = convertGridTemplateRows(value);
        break;

      // spacing系 - padding
      case 'padding': {
        // レスポンシブ対応: 大きなpaddingはレスポンシブクラスに変換
        if (responsive) {
          const pixels = parsePixelValue(value);
          if (pixels !== null && pixels >= RESPONSIVE_THRESHOLDS.padding) {
            responsiveClasses = convertLargePaddingResponsive(pixels, 'p');
          }
        }
        if (!responsiveClasses) {
          converted = convertSpacing(value, 'p');
        }
        break;
      }
      case 'paddingTop':
        converted = convertSpacing(value, 'pt');
        break;
      case 'paddingBottom':
        converted = convertSpacing(value, 'pb');
        break;
      case 'paddingLeft':
        converted = convertSpacing(value, 'pl');
        break;
      case 'paddingRight':
        converted = convertSpacing(value, 'pr');
        break;
      case 'paddingInline':
        converted = convertSpacing(value, 'px');
        break;
      case 'paddingBlock':
        converted = convertSpacing(value, 'py');
        break;

      // spacing系 - margin
      case 'margin':
        converted = convertSpacing(value, 'm');
        break;
      case 'marginTop':
        converted = convertSpacing(value, 'mt');
        break;
      case 'marginBottom':
        converted = convertSpacing(value, 'mb');
        break;
      case 'marginLeft':
        converted = convertSpacing(value, 'ml');
        break;
      case 'marginRight':
        converted = convertSpacing(value, 'mr');
        break;
      case 'marginInline':
        converted = convertSpacing(value, 'mx');
        break;
      case 'marginBlock':
        converted = convertSpacing(value, 'my');
        break;

      // sizing系 - width
      case 'width': {
        // レスポンシブ対応: 大きな固定幅はmax-w + w-fullに変換
        if (responsive) {
          const pixels = parsePixelValue(value);
          if (pixels !== null && pixels >= RESPONSIVE_THRESHOLDS.width) {
            responsiveClasses = convertLargeWidthResponsive(pixels);
          }
        }
        if (!responsiveClasses) {
          converted = convertWidth(value, 'w');
        }
        break;
      }
      case 'minWidth':
        converted = convertMinMaxSize(value, 'min-w');
        break;
      case 'maxWidth':
        converted = convertMinMaxSize(value, 'max-w');
        break;

      // sizing系 - height
      case 'height':
        converted = convertHeight(value, 'h');
        break;
      case 'minHeight':
        converted = convertMinMaxSize(value, 'min-h');
        break;
      case 'maxHeight':
        converted = convertMinMaxSize(value, 'max-h');
        break;

      // color系
      case 'backgroundColor':
        converted = convertBackgroundColor(value);
        break;
      case 'color':
        converted = convertTextColor(value);
        break;

      // typography系
      case 'fontSize': {
        // レスポンシブ対応: 大きなfontSizeはレスポンシブクラスに変換
        if (responsive) {
          const pixels = parsePixelValue(value);
          if (pixels !== null && pixels >= RESPONSIVE_THRESHOLDS.fontSize) {
            responsiveClasses = convertLargeFontSizeResponsive(pixels);
          }
        }
        if (!responsiveClasses) {
          converted = convertFontSize(value);
        }
        break;
      }
      case 'fontWeight':
        converted = convertFontWeight(value);
        break;
      case 'textAlign':
        converted = convertTextAlign(value);
        break;
      case 'lineHeight':
        converted = convertLineHeight(value);
        break;

      // border系
      case 'borderRadius':
        converted = convertBorderRadius(value);
        break;

      // position系
      case 'position':
        converted = convertPosition(value);
        break;

      // opacity系
      case 'opacity':
        converted = convertOpacity(value);
        break;

      // overflow系
      case 'overflow':
        converted = convertOverflow(value);
        break;
      case 'overflowX':
        converted = convertOverflow(value, '-x');
        break;
      case 'overflowY':
        converted = convertOverflow(value, '-y');
        break;

      // z-index系
      case 'zIndex':
        converted = convertZIndex(value);
        break;

      // cursor系
      case 'cursor':
        converted = convertCursor(value);
        break;

      // pointer-events系
      case 'pointerEvents':
        converted = convertPointerEvents(value);
        break;

      // user-select系
      case 'userSelect':
        converted = convertUserSelect(value);
        break;

      default:
        // 未対応のプロパティ
        break;
    }

    // レスポンシブクラス配列があればすべて追加
    if (responsiveClasses !== null && responsiveClasses.length > 0) {
      tailwindClasses.push(...responsiveClasses);
    } else if (converted !== null) {
      tailwindClasses.push(converted);
    } else {
      remainingStyles[property] = value;
    }
  }

  // 後処理: ml-auto + mr-auto → mx-auto の最適化
  const hasMarginLeftAuto = tailwindClasses.includes('ml-auto');
  const hasMarginRightAuto = tailwindClasses.includes('mr-auto');

  if (hasMarginLeftAuto && hasMarginRightAuto) {
    // ml-autoとmr-autoの両方を削除し、mx-autoに置き換え
    const optimizedClasses = tailwindClasses.filter(
      (cls) => cls !== 'ml-auto' && cls !== 'mr-auto'
    );
    optimizedClasses.push('mx-auto');

    return {
      tailwindClasses: optimizedClasses,
      remainingStyles,
    };
  }

  return {
    tailwindClasses,
    remainingStyles,
  };
}
