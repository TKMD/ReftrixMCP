// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPツール名の定数（SSoT: allToolDefinitions から自動導出）
 *
 * このファイルは allToolDefinitions を唯一の情報源として
 * TOOL_NAMES オブジェクトと ALL_TOOL_NAMES 配列を生成する。
 * ツールの追加/削除時は allToolDefinitions のみ更新すればOK。
 *
 * レイジー初期化パターン:
 * tools/index.ts → system-health.ts → router.ts → tool-names.ts → tools/index.ts
 * の循環参照を回避するため、allToolDefinitions は初回アクセス時に取得する。
 * 実際の使用時（validate-tool-list.ts やテスト等）にはすべてのモジュールが
 * ロード済みのため、循環の問題は発生しない。
 *
 * @module tools/tool-names
 */

/**
 * ツール名文字列をSCREAMING_SNAKE_CASEキーに変換
 *
 * 変換ルール:
 * 1. ドット(.)をアンダースコア(_)に変換
 * 2. camelCaseをsnake_caseに変換（大文字の前にアンダースコアを挿入）
 * 3. 全体を大文字に変換
 *
 * 例: "style.get_palette" → "STYLE_GET_PALETTE"
 *     "page.getJobStatus" → "PAGE_GET_JOB_STATUS"
 *     "design.track_changes" → "DESIGN_TRACK_CHANGES"
 *
 * @param name - ドット区切りのツール名
 * @returns SCREAMING_SNAKE_CASE形式のキー
 */
function toConstantKey(name: string): string {
  return name
    .replace(/\./g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

/** レイジー初期化キャッシュ */
let _toolNames: Record<string, string> | null = null;
let _allToolNames: readonly string[] | null = null;

/** tools/index.ts から登録されるツール定義（ESM/Vitest環境対応） */
let _registeredDefs: ReadonlyArray<{ name: string }> | null = null;

/**
 * tools/index.ts のモジュール評価完了時にツール定義を登録する
 *
 * ESM環境（Vitest等）では CJS require("./index") が .ts を解決できないため、
 * tools/index.ts 側から明示的に登録する。CJS環境では require() のフォールバックも保持。
 *
 * @internal tools/index.ts からのみ呼び出すこと
 */
export function _registerToolDefinitions(defs: ReadonlyArray<{ name: string }>): void {
  _registeredDefs = defs;
  // 再登録時にキャッシュをリセット（ホットリロード対応）
  _toolNames = null;
  _allToolNames = null;
}

/**
 * allToolDefinitions を遅延取得し TOOL_NAMES/ALL_TOOL_NAMES を初期化
 *
 * 初期化優先順: (1) _registerToolDefinitions() による登録済み定義
 *              (2) require() による遅延ロード（CJS環境フォールバック）
 * 呼び出し時点では tools/index.ts のモジュール評価が完了済みであるため安全。
 */
function ensureInitialized(): void {
  if (_toolNames !== null) return;

  let allToolDefinitions: ReadonlyArray<{ name: string }>;

  if (_registeredDefs) {
    allToolDefinitions = _registeredDefs;
  } else {
    // CJS環境（コンパイル済みJS）フォールバック
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./index") as {
      allToolDefinitions: ReadonlyArray<{ name: string }>;
    };
    allToolDefinitions = mod.allToolDefinitions;
  }

  _toolNames = Object.fromEntries(
    allToolDefinitions.map((def) => [toConstantKey(def.name), def.name])
  );
  _allToolNames = allToolDefinitions.map((def) => def.name);
}

/**
 * MCPツール名の定数オブジェクト（WebDesign専用）
 *
 * allToolDefinitions (tools/index.ts) から自動導出。
 * キー: SCREAMING_SNAKE_CASE（例: LAYOUT_GENERATE_CODE）
 * 値: ドット区切りツール名（例: "layout.generate_code"）
 *
 * Proxy によるレイジー初期化で循環参照を安全に回避。
 * Object.values(), プロパティアクセス, in 演算子, スプレッド演算子すべてに対応。
 */
export const TOOL_NAMES: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target: Record<string, string>, prop: string | symbol): string | undefined {
    if (typeof prop === "symbol") return undefined;
    ensureInitialized();
    return _toolNames![prop];
  },
  ownKeys(): string[] {
    ensureInitialized();
    return Object.keys(_toolNames!);
  },
  getOwnPropertyDescriptor(
    _target: Record<string, string>,
    prop: string | symbol
  ): PropertyDescriptor | undefined {
    if (typeof prop === "symbol") return undefined;
    ensureInitialized();
    if (prop in _toolNames!) {
      return { configurable: true, enumerable: true, value: _toolNames![prop] };
    }
    return undefined;
  },
  has(_target: Record<string, string>, prop: string | symbol): boolean {
    if (typeof prop === "symbol") return false;
    ensureInitialized();
    return prop in _toolNames!;
  },
});

/**
 * 全MCPツール名の配列（allToolDefinitionsから自動導出）
 *
 * Proxy によるレイジー初期化で循環参照を安全に回避。
 * スプレッド演算子([...ALL_TOOL_NAMES])、length、インデックスアクセス、
 * Array.prototype メソッド (sort, map, forEach 等) すべてに対応。
 */
export const ALL_TOOL_NAMES: readonly string[] = new Proxy([] as string[], {
  get(_target: string[], prop: string | symbol): unknown {
    ensureInitialized();
    const arr = _allToolNames!;

    if (prop === "length") return arr.length;

    if (typeof prop === "string") {
      const index = Number(prop);
      if (Number.isInteger(index) && index >= 0 && index < arr.length) {
        return arr[index];
      }
    }

    // Symbol.iterator（for...of, スプレッド演算子対応）
    if (prop === Symbol.iterator) {
      return arr[Symbol.iterator].bind(arr);
    }

    // Array.prototype メソッド（sort, map, forEach, includes, some 等）
    const arrProp = (arr as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof arrProp === "function") {
      return (arrProp as (...args: unknown[]) => unknown).bind(arr);
    }

    return arrProp;
  },
  ownKeys(): string[] {
    ensureInitialized();
    const arr = _allToolNames!;
    return [...Array.from({ length: arr.length }, (_, i) => String(i)), "length"];
  },
  getOwnPropertyDescriptor(
    _target: string[],
    prop: string | symbol
  ): PropertyDescriptor | undefined {
    ensureInitialized();
    const arr = _allToolNames!;

    if (prop === "length") {
      return { configurable: false, enumerable: false, writable: false, value: arr.length };
    }
    if (typeof prop === "string") {
      const index = Number(prop);
      if (Number.isInteger(index) && index >= 0 && index < arr.length) {
        return { configurable: true, enumerable: true, value: arr[index] };
      }
    }
    return undefined;
  },
  has(_target: string[], prop: string | symbol): boolean {
    ensureInitialized();
    const arr = _allToolNames!;
    if (typeof prop === "string") {
      const index = Number(prop);
      if (Number.isInteger(index) && index >= 0 && index < arr.length) return true;
    }
    return prop === "length";
  },
});
