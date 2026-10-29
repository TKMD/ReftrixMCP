// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — schema-enum-sync Zod collection extractor
 *
 * INV-ZOD-INPUT-COLLECTION-BOUNDED-002 用。登録済み MCP tool (`toolHandlers`) の入力 schema を
 * root として ts-morph で Zod の collection (`z.array` / `.array()` / `z.set` / `z.map` /
 * `z.record` / `z.tuple`) を辿り、それぞれの上限 (`.max(N)` / `.length(N)`) を解決する。
 *
 * Walks the input schemas of every registered MCP tool (`toolHandlers`) with ts-morph and
 * resolves the upper bound (`.max(N)` / `.length(N)`) of each Zod collection reached.
 *
 * 判定できない形 (N が数値リテラル / 数値 const に解決できない、識別子が宣言に辿れない、
 * 辿れない宣言・式の種類) は fail-closed: 上限なしとして扱い、解決失敗は `unresolved` に載せる。
 * 黙って捨ててよいのは、理由を付けて固定した下の 3 つだけ (zod 本体、標準ライブラリの Math、
 * 検証 callback の関数引数)。
 *
 * @module tests/regression/standing/schema-enum-sync/_zod-collections
 */

import path from "node:path";
import { Project, SyntaxKind as K, VariableDeclarationKind } from "ts-morph";
import type { AsExpression, CallExpression, Node, Symbol as TsSymbol } from "ts-morph";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");
const TOOLS_DIR = path.join(MCP_SERVER_ROOT, "src/tools");

export type CollectionKind = "array" | "set" | "map" | "record" | "tuple";

/**
 * toolHandlers の tool 名 → [handler file (src/tools 相対), 入力 schema の識別子]。
 * `system.health` は Zod 入力を持たない (null)。
 * 各 root 識別子が handler file 内で `.parse` / `.safeParse` されていること、および
 * キー集合が `toolHandlers` と一致することは test 側で検証する。
 */
export const TOOL_INPUT_ROOTS: Readonly<Record<string, readonly [string, string] | null>> = {
  "style.get_palette": ["style-get-palette.ts", "styleGetPaletteInputSchema"],
  "system.health": null,
  "layout.inspect": ["layout/inspect/inspect.tool.ts", "layoutInspectInputSchema"],
  "layout.ingest": ["layout/ingest.tool.ts", "layoutIngestInputSchema"],
  "layout.search": ["layout/search.tool.ts", "layoutSearchInputSchema"],
  "layout.generate_code": ["layout/to-code.tool.ts", "layoutToCodeInputSchema"],
  "layout.batch_ingest": ["layout/batch-ingest.tool.ts", "layoutBatchIngestInputSchema"],
  "quality.evaluate": ["quality/evaluate.tool.ts", "qualityEvaluateInputSchema"],
  "motion.detect": ["motion/detect.tool.ts", "motionDetectInputSchema"],
  "motion.search": ["motion/search.tool.ts", "motionSearchInputSchema"],
  "brief.validate": ["brief/validate.handler.ts", "briefValidateInputSchema"],
  "page.analyze": ["page/analyze.tool.ts", "pageAnalyzeInputSchema"],
  "page.getJobStatus": ["page/get-job-status.tool.ts", "pageGetJobStatusInputSchema"],
  "narrative.search": ["narrative/search.tool.ts", "narrativeSearchInputSchema"],
  "background.search": ["background/search.tool.ts", "backgroundSearchInputSchema"],
  "responsive.search": ["responsive/search.tool.ts", "responsiveSearchInputSchema"],
  "preference.hear": ["preference/hear.tool.ts", "preferenceHearInputSchema"],
  "preference.get": ["preference/get.tool.ts", "preferenceGetInputSchema"],
  "preference.reset": ["preference/reset.tool.ts", "preferenceResetInputSchema"],
  "part.search": ["part/search.tool.ts", "partSearchInputSchema"],
  "part.inspect": ["part/inspect.tool.ts", "partInspectInputSchema"],
  "part.compare": ["part/compare.tool.ts", "partCompareInputSchema"],
  "section.inspect": ["section/inspect.tool.ts", "sectionInspectInputSchema"],
  "search.unified": ["search-unified.tool.ts", "searchUnifiedInputSchema"],
  "search.facets": ["search/facets.tool.ts", "searchFacetsInputSchema"],
  "design.search_by_image": ["design/search-by-image.tool.ts", "designSearchByImageInputSchema"],
  "design.similar_site": ["design/similar-site.tool.ts", "designSimilarSiteInputSchema"],
  "design.compare": ["design/compare.tool.ts", "designCompareInputSchema"],
  "audit.query": ["audit/query.tool.ts", "auditQueryInputSchema"],
  "data.delete": ["data/data.tool.ts", "dataDeleteInputSchema"],
  "data.export": ["data/data.tool.ts", "dataExportInputSchema"],
  "embedding.quality": ["embedding/quality.tool.ts", "embeddingQualityInputSchema"],
  "accessibility.audit": ["accessibility/audit.tool.ts", "accessibilityAuditInputSchema"],
  "performance.evaluate": ["performance/evaluate.tool.ts", "performanceEvaluateInputSchema"],
  "responsive.capture": ["responsive/capture.tool.ts", "responsiveCaptureInputSchema"],
  "design.track_changes": ["design/track-changes.tool.ts", "designTrackChangesInputSchema"],
  "design.regression_test": ["design/regression-test.tool.ts", "designRegressionTestInputSchema"],
  "page.batch_analyze": ["page/batch-analyze.tool.ts", "batchAnalyzeInputSchema"],
  "page.getBatchStatus": ["page/get-batch-status.tool.ts", "getBatchStatusInputSchema"],
  "report.generate": ["report/generate.tool.ts", "reportGenerateInputSchema"],
};

export interface ZodCollection {
  /** `apps/mcp-server/` 相対の `file:line` */
  site: string;
  kind: CollectionKind;
  /** 解決できた上限 (`.max(N)` / `.length(N)`)。なし / 解決不能は null (fail-closed) */
  bound: number | null;
  /** `.max` / `.length` の引数テキスト (診断用) */
  boundText: string | null;
  tools: string[];
  /** 入力内の位置 (`a.b[].c`)。同じ collection が複数 path から到達されうる */
  paths: string[];
}

export interface ZodCollectionScan {
  collections: ZodCollection[];
  /** 宣言まで辿れなかった schema 識別子・式 (fail-closed 対象) */
  unresolved: string[];
}

const COLLECTION_METHODS = new Set<string>(["array", "set", "map", "record", "tuple"]);

/** zod 本体の import 元。symbol を import 宣言まで解決して判定する (識別子名の文字列では判定しない)。 */
const ZOD_MODULE = /^zod(\/|$)/;
/** 黙って捨てる標準ライブラリのグローバル Math (固定リスト)。 */
const STDLIB_GLOBALS = new Set<string>(["Math"]);
/** callback は schema を定義しない (検証・変換のみ) ので、その関数引数は辿らない (固定リスト)。 */
const CALLBACK_METHODS = new Set([
  "refine",
  "superRefine",
  "transform",
  "check",
  "overwrite",
  "preprocess",
]);
/** 値を持たない葉 (リテラル、プレフィックス演算、テンプレート)。辿る対象が無い。 */
const LEAF_KIND =
  /^(\w+Literal|(True|False|Null)Keyword|TemplateExpression|PrefixUnaryExpression)$/;

/** import 宣言が zod 由来なら、取り込んだ名前 (`z` / `array` / `*`) を返す。 */
function zodImportName(decl: Node | undefined): string | null {
  if (!decl) return null;
  const kind = decl.getKind();
  if (kind === K.ImportSpecifier) {
    const spec = decl.asKindOrThrow(K.ImportSpecifier);
    return ZOD_MODULE.test(spec.getImportDeclaration().getModuleSpecifierValue())
      ? spec.getName()
      : null;
  }
  if (kind === K.NamespaceImport || kind === K.ImportClause) {
    const imp = decl.getFirstAncestorByKind(K.ImportDeclaration);
    return imp && ZOD_MODULE.test(imp.getModuleSpecifierValue()) ? "*" : null;
  }
  return null;
}

/** 識別子が zod の import に解決されるなら、その取り込み名。 */
function zodRef(node: Node): string | null {
  if (node.getKind() !== K.Identifier) return null;
  return zodImportName(node.getSymbol()?.getDeclarations()[0]);
}

function isZodNamespace(node: Node): boolean {
  const name = zodRef(node);
  return name === "z" || name === "*";
}

function isStdlibGlobal(name: string, filePath: string): boolean {
  return STDLIB_GLOBALS.has(name) && /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(filePath);
}

export function createZodCollectionProject(): Project {
  return new Project({
    tsConfigFilePath: path.join(MCP_SERVER_ROOT, "tsconfig.json"),
    skipFileDependencyResolution: false,
  });
}

function relSite(node: Node): string {
  const file = node.getSourceFile().getFilePath();
  return `${path.relative(MCP_SERVER_ROOT, file)}:${node.getStartLineNumber()}`;
}

/** 数値リテラル / 数値 const (リテラル初期化) のみ解決する。それ以外は null。 */
function resolveNumber(node: Node | undefined): number | null {
  if (!node) return null;
  if (node.getKind() === K.NumericLiteral) return Number(node.getText());
  if (node.getKind() === K.Identifier) {
    const decl = node.getSymbol()?.getDeclarations()[0];
    // const のみ受理する (let / var は再代入で実効値が変わる)
    if (decl && decl.getKind() === K.VariableDeclaration) {
      const vd = decl.asKindOrThrow(K.VariableDeclaration);
      if (vd.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) {
        return null;
      }
      const init = vd.getInitializer();
      if (init && init.getKind() === K.NumericLiteral) return Number(init.getText());
    }
  }
  return null;
}

function chainBounds(call: CallExpression): { text: string | null; bound: number | null } {
  let cur: Node = call;
  let text: string | null = null;
  let bound: number | null = null;
  for (;;) {
    const parent = cur.getParent();
    if (parent && parent.getKind() === K.PropertyAccessExpression) {
      const pa = parent.asKindOrThrow(K.PropertyAccessExpression);
      const outer = pa.getParent();
      if (
        pa.getExpression() === cur &&
        outer &&
        outer.getKind() === K.CallExpression &&
        outer.asKindOrThrow(K.CallExpression).getExpression() === pa
      ) {
        const outerCall = outer.asKindOrThrow(K.CallExpression);
        const name = pa.getName();
        if (name === "max" || name === "length") {
          const arg = outerCall.getArguments()[0];
          text = arg ? arg.getText() : null;
          bound = resolveNumber(arg);
        }
        cur = outerCall;
        continue;
      }
    }
    return { text, bound };
  }
}

/** 登録 tool の入力 schema から到達できる Zod collection を全件列挙する。 */
export function scanZodCollections(
  project: Project,
  opts: {
    roots?: Readonly<Record<string, readonly [string, string] | null>>;
    toolsDir?: string;
  } = {}
): ZodCollectionScan {
  const roots = opts.roots ?? TOOL_INPUT_ROOTS;
  const toolsDir = opts.toolsDir ?? TOOLS_DIR;
  const found = new Map<string, ZodCollection & { _start: number }>();
  const unresolved = new Set<string>();
  const visiting = new Set<string>();

  const record = (call: CallExpression, kind: CollectionKind, tool: string, p: string): void => {
    const key = `${call.getSourceFile().getFilePath()}:${call.getStart()}`;
    let info = found.get(key);
    if (!info) {
      const { text, bound } = chainBounds(call);
      info = {
        site: relSite(call),
        kind,
        bound,
        boundText: text,
        tools: [],
        paths: [],
        _start: call.getStart(),
      };
      found.set(key, info);
    }
    if (!info.tools.includes(tool)) info.tools.push(tool);
    const pathLabel = p === "" ? "(root)" : p;
    if (!info.paths.includes(pathLabel)) info.paths.push(pathLabel);
  };

  const walkSymbol = (
    symbol: TsSymbol | undefined,
    n: Node,
    p: string,
    tool: string,
    depth: number
  ): void => {
    const label = `${relSite(n)} ${n.getText()}`;
    let sym = symbol;
    if (!sym) {
      unresolved.add(label);
      return;
    }
    // zod 本体 (import 宣言まで解決)。schema 定義ではないので辿らない
    if (zodImportName(sym.getDeclarations()[0])) return;
    const aliased = sym.getAliasedSymbol();
    if (aliased) sym = aliased;
    const decl = sym.getDeclarations()[0];
    if (!decl) {
      unresolved.add(label);
      return;
    }
    const filePath = decl.getSourceFile().getFilePath();
    if (/\/node_modules\/zod\//.test(filePath) || isStdlibGlobal(sym.getName(), filePath)) return;
    let target: Node | undefined;
    switch (decl.getKind()) {
      case K.VariableDeclaration:
        target = decl.asKindOrThrow(K.VariableDeclaration).getInitializer();
        break;
      case K.FunctionDeclaration:
        target = decl.asKindOrThrow(K.FunctionDeclaration).getBody();
        break;
      case K.PropertyAssignment:
        target = decl.asKindOrThrow(K.PropertyAssignment).getInitializer();
        break;
      default:
        // BindingElement / Parameter / class メンバー / .d.ts の宣言など、辿れない宣言
        unresolved.add(`${label} (${decl.getKindName()})`);
        return;
    }
    if (!target) {
      unresolved.add(`${label} (no body)`);
      return;
    }
    const vk = `${tool}|${filePath}:${decl.getStart()}|${p}`;
    if (visiting.has(vk)) return;
    visiting.add(vk);
    walk(target, p, tool, depth + 1);
  };

  const walk = (n: Node | undefined, p: string, tool: string, depth: number): void => {
    if (!n || depth > 200) return;
    switch (n.getKind()) {
      case K.Identifier: {
        if (["undefined", "NaN", "Infinity"].includes(n.getText())) return;
        walkSymbol(n.getSymbol(), n, p, tool, depth);
        return;
      }
      case K.ObjectLiteralExpression: {
        const obj = n.asKindOrThrow(K.ObjectLiteralExpression);
        for (const pr of obj.getProperties()) {
          if (pr.getKind() === K.PropertyAssignment) {
            const pa = pr.asKindOrThrow(K.PropertyAssignment);
            const nm = pa.getName().replace(/^["']|["']$/g, "");
            walk(pa.getInitializer(), p ? `${p}.${nm}` : nm, tool, depth + 1);
          } else if (pr.getKind() === K.SpreadAssignment) {
            walk(pr.asKindOrThrow(K.SpreadAssignment).getExpression(), p, tool, depth + 1);
          } else if (pr.getKind() === K.ShorthandPropertyAssignment) {
            const sh = pr.asKindOrThrow(K.ShorthandPropertyAssignment);
            walkSymbol(
              sh.getValueSymbol(),
              sh.getNameNode(),
              p ? `${p}.${sh.getName()}` : sh.getName(),
              tool,
              depth + 1
            );
          } else {
            // メソッド / getter / setter は返す schema を辿れない
            unresolved.add(`${relSite(pr)} object member (${pr.getKindName()})`);
          }
        }
        return;
      }
      case K.ArrowFunction:
        walk(n.asKindOrThrow(K.ArrowFunction).getBody(), p, tool, depth + 1);
        return;
      case K.FunctionExpression:
        walk(n.asKindOrThrow(K.FunctionExpression).getBody(), p, tool, depth + 1);
        return;
      case K.Block:
        for (const r of n.getDescendantsOfKind(K.ReturnStatement)) {
          walk(r.getExpression(), p, tool, depth + 1);
        }
        return;
      case K.PropertyAccessExpression: {
        const pa = n.asKindOrThrow(K.PropertyAccessExpression);
        const nameNode = pa.getNameNode();
        const d = nameNode.getSymbol()?.getDeclarations()[0];
        if (d && (d.getKind() === K.PropertyAssignment || d.getKind() === K.VariableDeclaration)) {
          walk(nameNode, p, tool, depth + 1);
        }
        if (d && d.getKind() === K.ShorthandPropertyAssignment) {
          walkSymbol(
            d.asKindOrThrow(K.ShorthandPropertyAssignment).getValueSymbol(),
            nameNode,
            p,
            tool,
            depth + 1
          );
        }
        walk(pa.getExpression(), p, tool, depth + 1);
        return;
      }
      case K.CallExpression: {
        const call = n.asKindOrThrow(K.CallExpression);
        const callee = call.getExpression();
        const args = call.getArguments();
        let handled = false;
        let method: string | null = null;
        let isZ = false;
        let recv: Node | undefined;
        if (callee.getKind() === K.PropertyAccessExpression) {
          const pa = callee.asKindOrThrow(K.PropertyAccessExpression);
          method = pa.getName();
          recv = pa.getExpression();
          isZ = isZodNamespace(recv);
        } else if (callee.getKind() === K.Identifier) {
          // `import { array } from "zod"` の素の呼出
          const imported = zodRef(callee);
          if (imported && COLLECTION_METHODS.has(imported)) {
            method = imported;
            isZ = true;
          }
        }
        if (method !== null) {
          if (
            COLLECTION_METHODS.has(method) &&
            (isZ || (method === "array" && args.length === 0))
          ) {
            record(call, method as CollectionKind, tool, p);
            if (isZ) {
              if (method === "array" || method === "set") {
                walk(args[0], `${p}[]`, tool, depth + 1);
              } else if (method === "map" || method === "record") {
                for (const a of args)
                  walk(a, `${p}${method === "record" ? "{}" : "<map>"}`, tool, depth + 1);
              } else {
                const first = args[0];
                if (first && first.getKind() === K.ArrayLiteralExpression) {
                  first
                    .asKindOrThrow(K.ArrayLiteralExpression)
                    .getElements()
                    .forEach((e, i) => walk(e, `${p}[${i}]`, tool, depth + 1));
                } else {
                  unresolved.add(`${relSite(call)} z.tuple(non-literal)`);
                }
              }
            } else if (recv) {
              walk(recv, `${p}[]`, tool, depth + 1);
            }
            handled = true;
          }
        }
        if (!handled) {
          walk(callee, p, tool, depth + 1);
          const callbackOnly = method !== null && CALLBACK_METHODS.has(method);
          for (const a of args) {
            // 検証・変換 callback は schema を定義しない
            if (
              callbackOnly &&
              (a.getKind() === K.ArrowFunction || a.getKind() === K.FunctionExpression)
            ) {
              continue;
            }
            walk(a, p, tool, depth + 1);
          }
        }
        return;
      }
      case K.NewExpression:
        // `new ZodArray(...)` などは辿れない
        unresolved.add(`${relSite(n)} ${n.getText().slice(0, 40)}`);
        return;
      case K.SpreadElement:
      case K.AsExpression:
      case K.ParenthesizedExpression:
      case K.NonNullExpression:
      case K.SatisfiesExpression:
        walk((n as AsExpression).getExpression(), p, tool, depth + 1);
        return;
      case K.ArrayLiteralExpression:
        for (const e of n.asKindOrThrow(K.ArrayLiteralExpression).getElements()) {
          walk(e, p, tool, depth + 1);
        }
        return;
      case K.ConditionalExpression: {
        const c = n.asKindOrThrow(K.ConditionalExpression);
        walk(c.getWhenTrue(), p, tool, depth + 1);
        walk(c.getWhenFalse(), p, tool, depth + 1);
        return;
      }
      case K.BinaryExpression: {
        const b = n.asKindOrThrow(K.BinaryExpression);
        walk(b.getLeft(), p, tool, depth + 1);
        walk(b.getRight(), p, tool, depth + 1);
        return;
      }
      default:
        if (LEAF_KIND.test(n.getKindName())) return;
        // 辿れない式 (ElementAccess など) は黙って捨てず fail-closed
        unresolved.add(`${relSite(n)} ${n.getKindName()}`);
        return;
    }
  };

  for (const [tool, root] of Object.entries(roots)) {
    if (!root) continue;
    const sf = project.getSourceFileOrThrow(path.join(toolsDir, root[0]));
    const id = sf.getDescendantsOfKind(K.Identifier).find((i) => i.getText() === root[1]);
    if (!id) {
      unresolved.add(`${root[0]} root ${root[1]} not found`);
      continue;
    }
    walk(id, "", tool, 0);
  }

  const collections = [...found.values()]
    .sort((a, b) => a.site.localeCompare(b.site, "en", { numeric: true }))
    .map(({ _start, ...rest }) => {
      void _start;
      return rest;
    });
  return { collections, unresolved: [...unresolved].sort() };
}
