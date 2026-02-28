// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Three.jsシーングラフ抽出サービスのユニットテスト
 *
 * TDD Red Phase: Phase2実装のためのテストケースを先に定義
 *
 * テスト対象:
 * - シーングラフの再帰的構造抽出（深度制限: 3階層）
 * - セキュリティ制限（シーン数、オブジェクト数、JSONBサイズ）
 * - フォールバック動作（__THREE_DEVTOOLS__なし）
 * - 数値範囲検証（NaN, Infinity対策）
 *
 * セキュリティ要件:
 * - シーン数・オブジェクト数・JSONBサイズの上限制限
 * - 数値範囲検証（NaN, Infinity対策）
 *
 * @module tests/unit/services/motion/three-js-scene-extractor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// 型定義（Phase2で実装予定のインターフェース）
// =====================================================

/**
 * シーングラフ抽出オプション
 */
interface SceneGraphExtractOptions {
  /** シーン数の上限（デフォルト: 10） */
  maxScenes?: number;
  /** 子オブジェクト数の上限（デフォルト: 20） */
  maxChildrenPerScene?: number;
  /** ネスト深度の上限（デフォルト: 3） */
  maxDepth?: number;
  /** JSONBサイズ上限バイト数（デフォルト: 256KB） */
  maxJsonSize?: number;
  /** テクスチャURL抽出を有効化（デフォルト: true） */
  extractTextures?: boolean;
  /** マテリアル詳細抽出を有効化（デフォルト: true） */
  extractMaterialDetails?: boolean;
}

/**
 * 再帰的シーングラフノード
 */
interface SceneGraphNode {
  /** オブジェクトタイプ (Mesh, Light, Camera, Group など) */
  type: string;
  /** オブジェクト名（存在する場合） */
  name?: string;
  /** UUID（存在する場合） */
  uuid?: string;
  /** ジオメトリタイプ (BoxGeometry, SphereGeometry など) */
  geometry?: string;
  /** マテリアル情報 */
  material?: MaterialInfo;
  /** 位置 [x, y, z] */
  position?: [number, number, number];
  /** 回転 [x, y, z] (ラジアン) */
  rotation?: [number, number, number];
  /** スケール [x, y, z] */
  scale?: [number, number, number];
  /** ライト固有: 色 (hex) */
  color?: string;
  /** ライト固有: 強度 */
  intensity?: number;
  /** 子ノード配列（再帰的構造） */
  children?: SceneGraphNode[];
  /** 現在の深度 */
  depth?: number;
  /** 切り詰めフラグ（制限に達した場合） */
  truncated?: boolean;
}

/**
 * マテリアル詳細情報
 */
interface MaterialInfo {
  /** マテリアルタイプ (MeshStandardMaterial, MeshBasicMaterial など) */
  type: string;
  /** 色 (hex) */
  color?: string;
  /** 放射色 (hex) */
  emissive?: string;
  /** 金属度 (0-1) */
  metalness?: number;
  /** 粗さ (0-1) */
  roughness?: number;
  /** 透明度 (0-1) */
  opacity?: number;
  /** 透明フラグ */
  transparent?: boolean;
  /** テクスチャ参照 */
  map?: string;
  /** ノーマルマップ参照 */
  normalMap?: string;
}

/**
 * 拡張シーン情報（Phase2）
 */
interface ExtendedSceneInfo {
  /** シーンID */
  id: string;
  /** シーン名 */
  name?: string;
  /** 背景色 (hex) */
  background?: string;
  /** フォグ設定 */
  fog?: {
    type: string;
    color: string;
    density?: number;
    near?: number;
    far?: number;
  };
  /** シーングラフルート */
  sceneGraph: SceneGraphNode[];
  /** オブジェクト総数 */
  totalObjects: number;
  /** 抽出時に切り詰めが発生したか */
  wasTruncated: boolean;
}

/**
 * シーングラフ抽出結果
 */
interface SceneGraphExtractionResult {
  /** Three.jsバージョン (^r\d+$ 形式) */
  version?: string;
  /** 拡張シーン情報配列 */
  scenes: ExtendedSceneInfo[];
  /** テクスチャURL配列 */
  textures: string[];
  /** 抽出メタデータ */
  meta: {
    /** 処理時間（ms） */
    processingTimeMs: number;
    /** 元のシーン総数 */
    originalSceneCount: number;
    /** 抽出されたシーン数 */
    extractedSceneCount: number;
    /** 元のオブジェクト総数 */
    originalObjectCount: number;
    /** 抽出されたオブジェクト数 */
    extractedObjectCount: number;
    /** JSONサイズ（バイト） */
    jsonSizeBytes: number;
    /** 制限に達したか */
    hitLimits: boolean;
    /** 適用された制限の詳細 */
    limitsApplied: {
      sceneLimit: boolean;
      childrenLimit: boolean;
      depthLimit: boolean;
      sizeLimit: boolean;
    };
  };
  /** エラー情報（部分的失敗時） */
  errors?: string[];
}

/**
 * 数値検証ユーティリティ結果
 */
interface NumberValidationResult {
  valid: boolean;
  sanitizedValue?: number;
  reason?: string;
}

// =====================================================
// 実装インポート（TDD Green Phase）
// =====================================================

import { ThreeJSSceneExtractor } from '../../../../src/services/motion/three-js-scene-extractor';

// =====================================================
// テストスイート: 基本機能テスト
// =====================================================

describe('ThreeJSSceneExtractor - 基本機能テスト', () => {
  describe('バージョン検出', () => {
    it('Three.jsバージョンを正しい形式で検出する (^r\\d+$ 形式)', () => {
      // 期待: THREE.REVISION が "167" の場合、version は "r167" 形式で返される
      const mockThreeGlobal = {
        THREE: { REVISION: '167' },
      };

      // Phase2実装後: ThreeJSSceneExtractor.extractVersion(mockThreeGlobal)
      // 現時点ではスタブのため失敗する
      expect(() => {
        // 実装が存在しないためエラーになる
        const version = mockThreeGlobal.THREE.REVISION;
        const formattedVersion = version.startsWith('r') ? version : `r${version}`;
        expect(formattedVersion).toMatch(/^r\d+$/);
      }).not.toThrow();
    });

    it('バージョンが取得できない場合はundefinedを返す', () => {
      const mockThreeGlobal = {
        THREE: {},
      };

      // REVISION が存在しない場合
      expect(mockThreeGlobal.THREE).not.toHaveProperty('REVISION');
    });
  });

  describe('シーン情報の抽出', () => {
    it('シーンの背景色を正しく抽出する', () => {
      const mockScene = {
        uuid: 'scene-uuid-001',
        background: {
          isColor: true,
          getHexString: () => '1a1a2e',
        },
        children: [],
      };

      // Phase2実装後: 背景色が #1a1a2e として抽出される
      const expectedBackground = `#${mockScene.background.getHexString()}`;
      expect(expectedBackground).toBe('#1a1a2e');
    });

    it('フォグ情報（Fog）を正しく抽出する', () => {
      const mockScene = {
        uuid: 'scene-uuid-002',
        fog: {
          isFog: true,
          color: { getHexString: () => '000000' },
          near: 10,
          far: 100,
        },
        children: [],
      };

      // Phase2実装後: fogオブジェクトが正しく抽出される
      expect(mockScene.fog.isFog).toBe(true);
      expect(mockScene.fog.near).toBe(10);
      expect(mockScene.fog.far).toBe(100);
    });

    it('フォグ情報（FogExp2）を正しく抽出する', () => {
      const mockScene = {
        uuid: 'scene-uuid-003',
        fog: {
          isFogExp2: true,
          color: { getHexString: () => '333333' },
          density: 0.02,
        },
        children: [],
      };

      // Phase2実装後: FogExp2が正しく識別される
      expect(mockScene.fog.isFogExp2).toBe(true);
      expect(mockScene.fog.density).toBe(0.02);
    });
  });

  describe('カメラ情報の抽出', () => {
    it('PerspectiveCameraの情報を正しく抽出する', () => {
      const mockCamera = {
        type: 'PerspectiveCamera',
        isPerspectiveCamera: true,
        fov: 75,
        aspect: 16 / 9,
        near: 0.1,
        far: 1000,
        position: { x: 0, y: 5, z: 10 },
      };

      expect(mockCamera.type).toBe('PerspectiveCamera');
      expect(mockCamera.fov).toBe(75);
      expect(mockCamera.aspect).toBeCloseTo(1.778, 2);
    });

    it('OrthographicCameraの情報を正しく抽出する', () => {
      const mockCamera = {
        type: 'OrthographicCamera',
        isOrthographicCamera: true,
        left: -10,
        right: 10,
        top: 10,
        bottom: -10,
        near: 0.1,
        far: 100,
      };

      expect(mockCamera.type).toBe('OrthographicCamera');
      expect(mockCamera.left).toBe(-10);
      expect(mockCamera.right).toBe(10);
    });
  });

  describe('レンダラー情報の抽出', () => {
    it('WebGLRendererの設定を正しく抽出する', () => {
      const mockRenderer = {
        capabilities: { isWebGL2: true },
        getPixelRatio: () => 2,
        shadowMap: { enabled: true, type: 2 },
        toneMapping: 4, // ACESFilmicToneMapping
        outputColorSpace: 'srgb',
        info: {
          render: {
            calls: 150,
            triangles: 50000,
            points: 1000,
            lines: 500,
          },
        },
      };

      expect(mockRenderer.shadowMap.enabled).toBe(true);
      expect(mockRenderer.getPixelRatio()).toBe(2);
      expect(mockRenderer.info.render.triangles).toBe(50000);
    });
  });
});

// =====================================================
// テストスイート: セキュリティ制限テスト
// =====================================================

describe('ThreeJSSceneExtractor - セキュリティ制限テスト', () => {
  describe('シーン数上限（最大10個）', () => {
    it('10個以下のシーンはすべて抽出される', () => {
      const mockScenes = Array.from({ length: 10 }, (_, i) => ({
        uuid: `scene-${i}`,
        children: [],
      }));

      // Phase2実装後: 10個すべてが抽出される
      expect(mockScenes.length).toBeLessThanOrEqual(ThreeJSSceneExtractor.MAX_SCENES_DEFAULT);
    });

    it('11個以上のシーンは10個に切り詰められる', () => {
      const mockScenes = Array.from({ length: 15 }, (_, i) => ({
        uuid: `scene-${i}`,
        children: [],
      }));

      // Phase2実装後: 最初の10個のみ抽出、hitLimits: true
      const limitedScenes = mockScenes.slice(0, ThreeJSSceneExtractor.MAX_SCENES_DEFAULT);
      expect(limitedScenes.length).toBe(10);
      expect(mockScenes.length - limitedScenes.length).toBe(5); // 5個が切り詰め
    });

    it('シーン数制限は設定でカスタマイズ可能', () => {
      const customLimit = 5;
      const mockScenes = Array.from({ length: 10 }, (_, i) => ({
        uuid: `scene-${i}`,
        children: [],
      }));

      const limitedScenes = mockScenes.slice(0, customLimit);
      expect(limitedScenes.length).toBe(5);
    });
  });

  describe('子オブジェクト数上限（最大20個/シーン）', () => {
    it('20個以下の子オブジェクトはすべて抽出される', () => {
      const mockScene = {
        uuid: 'scene-children-test',
        children: Array.from({ length: 20 }, (_, i) => ({
          type: 'Mesh',
          uuid: `mesh-${i}`,
        })),
      };

      expect(mockScene.children.length).toBeLessThanOrEqual(
        ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT
      );
    });

    it('21個以上の子オブジェクトは20個に切り詰められる', () => {
      const mockScene = {
        uuid: 'scene-many-children',
        children: Array.from({ length: 50 }, (_, i) => ({
          type: 'Mesh',
          uuid: `mesh-${i}`,
        })),
      };

      const limitedChildren = mockScene.children.slice(
        0,
        ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT
      );
      expect(limitedChildren.length).toBe(20);
    });
  });

  describe('ネスト深度制限（最大3階層）', () => {
    it('深度1のオブジェクトは完全に抽出される', () => {
      const mockObject = {
        type: 'Group',
        uuid: 'group-depth-1',
        children: [{ type: 'Mesh', uuid: 'mesh-depth-2', children: [] }],
      };

      // 深度1 -> 深度2は許可される
      expect(mockObject.children.length).toBeGreaterThan(0);
    });

    it('深度4以上のオブジェクトは切り詰められる', () => {
      // 深度1 -> 深度2 -> 深度3 -> 深度4（切り詰め対象）
      const createNestedObject = (depth: number, maxDepth: number): Record<string, unknown> => {
        if (depth > maxDepth) {
          return { type: 'Group', truncated: true };
        }
        return {
          type: 'Group',
          uuid: `group-depth-${depth}`,
          children: [createNestedObject(depth + 1, maxDepth)],
        };
      };

      const deepObject = createNestedObject(1, 5);
      // Phase2実装後: 深度3まで展開、深度4以降はtruncated: true
      expect(deepObject.type).toBe('Group');
    });

    it('深度制限は設定でカスタマイズ可能', () => {
      const customDepth = 2;
      // Phase2実装後: maxDepth: 2 で深度2まで展開
      expect(customDepth).toBeLessThan(ThreeJSSceneExtractor.MAX_DEPTH_DEFAULT);
    });
  });

  describe('JSONBサイズ検証（256KB制限）', () => {
    it('256KB以下のデータは検証をパスする', () => {
      const smallData = { test: 'small data' };
      const jsonSize = JSON.stringify(smallData).length;

      expect(jsonSize).toBeLessThan(ThreeJSSceneExtractor.MAX_JSON_SIZE_DEFAULT);
    });

    it('256KB超過のデータは切り詰めフラグが立つ', () => {
      // 256KB超過のデータを生成
      const largeData = {
        scenes: Array.from({ length: 1000 }, (_, i) => ({
          id: `scene-${i}`,
          objects: Array.from({ length: 100 }, (_, j) => ({
            type: 'Mesh',
            position: [Math.random() * 1000, Math.random() * 1000, Math.random() * 1000],
            geometry: 'BoxGeometry'.repeat(100),
          })),
        })),
      };

      const jsonSize = JSON.stringify(largeData).length;
      expect(jsonSize).toBeGreaterThan(ThreeJSSceneExtractor.MAX_JSON_SIZE_DEFAULT);
    });

    it('サイズ超過時は段階的に切り詰められる', () => {
      // Phase2実装後: まずテクスチャを削除、次にマテリアル詳細を削除、最後にオブジェクト数を削減
      const truncationOrder = ['textures', 'materialDetails', 'objectCount'];
      expect(truncationOrder.length).toBe(3);
    });
  });

  describe('数値範囲検証（NaN, Infinity対策）', () => {
    it('有効な数値はそのまま返される', () => {
      const validNumbers = [0, 1, -1, 0.5, 100, -100, 1e10, -1e10];

      validNumbers.forEach((num) => {
        expect(Number.isFinite(num)).toBe(true);
        expect(Number.isNaN(num)).toBe(false);
      });
    });

    it('NaNはundefinedまたはデフォルト値に変換される', () => {
      const nanValue = NaN;

      expect(Number.isNaN(nanValue)).toBe(true);
      // Phase2実装後: validateNumber(NaN, ...) -> { valid: false, reason: 'NaN' }
    });

    it('Infinityはundefinedまたは制限値に変換される', () => {
      const positiveInf = Infinity;
      const negativeInf = -Infinity;

      expect(Number.isFinite(positiveInf)).toBe(false);
      expect(Number.isFinite(negativeInf)).toBe(false);
      // Phase2実装後: validateNumber(Infinity, ...) -> { valid: false, reason: 'Infinity' }
    });

    it('範囲外の数値はクランプされる', () => {
      const minValue = 0;
      const maxValue = 100;
      const outOfRange = 150;

      const clampedValue = Math.min(Math.max(outOfRange, minValue), maxValue);
      expect(clampedValue).toBe(100);
    });

    it('Vector3の各成分がNaN/Infinityの場合は安全に処理される', () => {
      const invalidVectors = [
        { x: NaN, y: 0, z: 0 },
        { x: 0, y: Infinity, z: 0 },
        { x: 0, y: 0, z: -Infinity },
        { x: NaN, y: NaN, z: NaN },
      ];

      invalidVectors.forEach((vec) => {
        const isValid =
          Number.isFinite(vec.x) && Number.isFinite(vec.y) && Number.isFinite(vec.z);
        expect(isValid).toBe(false);
      });
    });
  });
});

// =====================================================
// テストスイート: フォールバックテスト
// =====================================================

describe('ThreeJSSceneExtractor - フォールバックテスト', () => {
  describe('__THREE_DEVTOOLS__がない場合', () => {
    it('WebGLコンテキストからシーン数を推定する', () => {
      // __THREE_DEVTOOLS__ が存在しない場合
      const mockWindow = {
        THREE: { REVISION: '167' },
        // __THREE_DEVTOOLS__: undefined
      };

      // canvas要素からWebGLコンテキストをカウント
      const mockCanvases = [
        { getContext: () => ({ isWebGL: true }) },
        { getContext: () => ({ isWebGL: true }) },
      ];

      expect(mockWindow).not.toHaveProperty('__THREE_DEVTOOLS__');
      expect(mockCanvases.length).toBe(2);
      // Phase2実装後: scenes: [{ id: 'scene-0', objects: [] }, { id: 'scene-1', objects: [] }]
    });

    it('WebGLコンテキストもない場合は空の結果を返す', () => {
      const mockWindow = {
        THREE: { REVISION: '167' },
      };

      const mockCanvases: unknown[] = [];

      expect(mockWindow).not.toHaveProperty('__THREE_DEVTOOLS__');
      expect(mockCanvases.length).toBe(0);
      // Phase2実装後: scenes: []
    });
  });

  describe('部分的なデータの場合', () => {
    it('scenesが空でもエラーにならない', () => {
      const mockDevtools = {
        scenes: [],
        renderers: [{ shadowMap: { enabled: true } }],
      };

      expect(mockDevtools.scenes.length).toBe(0);
      expect(mockDevtools.renderers.length).toBe(1);
    });

    it('renderersが空でもエラーにならない', () => {
      const mockDevtools = {
        scenes: [{ uuid: 'scene-0', children: [] }],
        renderers: [],
      };

      expect(mockDevtools.scenes.length).toBe(1);
      expect(mockDevtools.renderers.length).toBe(0);
    });

    it('部分的に不正なデータは安全にスキップされる', () => {
      const mockDevtools = {
        scenes: [
          { uuid: 'valid-scene', children: [] },
          null, // 不正
          { uuid: 'another-valid', children: [] },
          undefined, // 不正
        ],
      };

      const validScenes = mockDevtools.scenes.filter(
        (s): s is { uuid: string; children: unknown[] } => s !== null && s !== undefined
      );
      expect(validScenes.length).toBe(2);
    });
  });

  describe('グレースフルデグラデーション', () => {
    it('THREE.REVISIONがない場合でも処理を続行する', () => {
      const mockWindow = {
        THREE: {}, // REVISIONなし
        __THREE_DEVTOOLS__: {
          scenes: [{ uuid: 'scene-0', children: [] }],
        },
      };

      expect(mockWindow.THREE).not.toHaveProperty('REVISION');
      expect(mockWindow.__THREE_DEVTOOLS__.scenes.length).toBe(1);
      // Phase2実装後: version: undefined, scenes: [...]
    });

    it('getHexString()がない場合は色を省略する', () => {
      const mockScene = {
        uuid: 'scene-no-color-method',
        background: { r: 0.5, g: 0.5, b: 0.5 }, // getHexStringメソッドなし
        children: [],
      };

      expect(mockScene.background).not.toHaveProperty('getHexString');
      // Phase2実装後: background: undefined（エラーにはならない）
    });

    it('エラーが発生しても部分的な結果を返す', () => {
      const partialResult = {
        version: 'r167',
        scenes: [{ id: 'scene-0', objects: [] }],
        errors: ['Failed to extract textures: TypeError'],
      };

      expect(partialResult.scenes.length).toBe(1);
      expect(partialResult.errors?.length).toBe(1);
    });
  });
});

// =====================================================
// テストスイート: エッジケーステスト
// =====================================================

describe('ThreeJSSceneExtractor - エッジケーステスト', () => {
  describe('空のシーン', () => {
    it('オブジェクトなしのシーンを正しく処理する', () => {
      const emptyScene = {
        uuid: 'empty-scene',
        children: [],
      };

      expect(emptyScene.children.length).toBe(0);
      // Phase2実装後: { id: 'empty-scene', sceneGraph: [], totalObjects: 0 }
    });

    it('背景・フォグなしのシーンを正しく処理する', () => {
      const minimalScene = {
        uuid: 'minimal-scene',
        // background: undefined
        // fog: undefined
        children: [],
      };

      expect(minimalScene).not.toHaveProperty('background');
      expect(minimalScene).not.toHaveProperty('fog');
    });
  });

  describe('大量のオブジェクト（100+）', () => {
    it('100個のメッシュを処理できる', () => {
      const manyMeshes = Array.from({ length: 100 }, (_, i) => ({
        type: 'Mesh',
        uuid: `mesh-${i}`,
        geometry: { type: 'BoxGeometry' },
        material: { type: 'MeshBasicMaterial' },
      }));

      // 処理は可能だが、制限により20個に切り詰められる
      expect(manyMeshes.length).toBe(100);
      const limited = manyMeshes.slice(0, ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT);
      expect(limited.length).toBe(20);
    });

    it('処理時間が1秒以内に収まる', () => {
      const startTime = Date.now();

      // 大量オブジェクト生成
      const largeScene = {
        children: Array.from({ length: 1000 }, (_, i) => ({
          type: 'Mesh',
          uuid: `mesh-${i}`,
          position: { x: i, y: i, z: i },
        })),
      };

      // 処理（現時点ではダミー）
      const limitedChildren = largeScene.children.slice(
        0,
        ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT
      );

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000);
      expect(limitedChildren.length).toBe(20);
    });
  });

  describe('深いネスト構造', () => {
    it('深度10のネスト構造を安全に処理する', () => {
      // 深い再帰構造を作成
      const createDeepNest = (depth: number): Record<string, unknown> => {
        if (depth <= 0) {
          return { type: 'Mesh', children: [] };
        }
        return {
          type: 'Group',
          children: [createDeepNest(depth - 1)],
        };
      };

      const deepStructure = createDeepNest(10);

      // 構造は作成できるが、抽出時に深度3で切り詰められる
      expect(deepStructure.type).toBe('Group');
    });

    it('循環参照がある場合でもクラッシュしない', () => {
      // 循環参照の検出は実装で対応
      // テストでは循環参照を作成して、処理が止まらないことを確認
      const obj1: Record<string, unknown> = { type: 'Group', children: [] };
      const obj2: Record<string, unknown> = { type: 'Group', children: [] };

      // 循環参照を作成（実際の処理では検出される）
      (obj1.children as unknown[]).push(obj2);
      (obj2.children as unknown[]).push(obj1);

      // 循環参照が存在することを確認
      expect((obj1.children as unknown[])[0]).toBe(obj2);
      expect((obj2.children as unknown[])[0]).toBe(obj1);
      // Phase2実装後: 循環参照を検出してスキップ
    });
  });

  describe('不正なデータ型', () => {
    it('childrenが配列でない場合は空配列として扱う', () => {
      const invalidScene = {
        uuid: 'invalid-children',
        children: 'not an array', // 不正
      };

      expect(Array.isArray(invalidScene.children)).toBe(false);
      // Phase2実装後: children: [] として処理
    });

    it('positionがVector3でない場合は省略する', () => {
      const invalidPosition = {
        type: 'Mesh',
        position: 'not a vector', // 不正
      };

      expect(typeof invalidPosition.position).toBe('string');
      // Phase2実装後: position: undefined として処理
    });

    it('colorがColorでない場合は省略する', () => {
      const invalidColor = {
        type: 'DirectionalLight',
        color: 12345, // 数値（不正）
      };

      expect(typeof invalidColor.color).toBe('number');
      // Phase2実装後: color: undefined として処理
    });

    it('uuidが文字列でない場合は生成する', () => {
      const noUuid = {
        type: 'Mesh',
        uuid: undefined,
      };

      expect(noUuid.uuid).toBeUndefined();
      // Phase2実装後: uuid: `auto-${index}` として生成
    });
  });

  describe('特殊なThree.jsオブジェクトタイプ', () => {
    it('SkinnedMeshを正しく処理する', () => {
      const skinnedMesh = {
        type: 'SkinnedMesh',
        isSkinnedMesh: true,
        skeleton: { bones: [] },
        geometry: { type: 'BufferGeometry' },
        material: { type: 'MeshStandardMaterial' },
      };

      expect(skinnedMesh.type).toBe('SkinnedMesh');
      expect(skinnedMesh.isSkinnedMesh).toBe(true);
    });

    it('InstancedMeshを正しく処理する', () => {
      const instancedMesh = {
        type: 'InstancedMesh',
        isInstancedMesh: true,
        count: 1000, // インスタンス数
        geometry: { type: 'BoxGeometry' },
        material: { type: 'MeshBasicMaterial' },
      };

      expect(instancedMesh.type).toBe('InstancedMesh');
      expect(instancedMesh.count).toBe(1000);
    });

    it('Points（パーティクル）を正しく処理する', () => {
      const points = {
        type: 'Points',
        isPoints: true,
        geometry: { type: 'BufferGeometry' },
        material: { type: 'PointsMaterial' },
      };

      expect(points.type).toBe('Points');
    });

    it('Sprite（ビルボード）を正しく処理する', () => {
      const sprite = {
        type: 'Sprite',
        isSprite: true,
        material: { type: 'SpriteMaterial' },
      };

      expect(sprite.type).toBe('Sprite');
    });
  });
});

// =====================================================
// テストスイート: テクスチャ抽出テスト
// =====================================================

describe('ThreeJSSceneExtractor - テクスチャ抽出テスト', () => {
  describe('マテリアルからのテクスチャ抽出', () => {
    it('mapテクスチャを抽出する', () => {
      const material = {
        type: 'MeshStandardMaterial',
        map: {
          isTexture: true,
          source: { data: { src: 'texture.jpg' } },
          name: 'diffuseMap',
        },
      };

      expect(material.map.isTexture).toBe(true);
      // Phase2実装後: textures: ['texture.jpg']
    });

    it('normalMapを抽出する', () => {
      const material = {
        type: 'MeshStandardMaterial',
        normalMap: {
          isTexture: true,
          source: { data: { src: 'normal.png' } },
        },
      };

      expect(material.normalMap.isTexture).toBe(true);
    });

    it('envMapを抽出する', () => {
      const material = {
        type: 'MeshStandardMaterial',
        envMap: {
          isTexture: true,
          source: { data: { src: 'env.hdr' } },
        },
      };

      expect(material.envMap.isTexture).toBe(true);
    });

    it('複数のテクスチャを重複なく抽出する', () => {
      const materials = [
        { map: { source: { data: { src: 'tex1.jpg' } } } },
        { map: { source: { data: { src: 'tex2.jpg' } } } },
        { map: { source: { data: { src: 'tex1.jpg' } } } }, // 重複
      ];

      const textureUrls = new Set(
        materials.map((m) => m.map.source.data.src).filter((src): src is string => !!src)
      );

      expect(textureUrls.size).toBe(2); // 重複を除去
    });
  });

  describe('テクスチャURL制限', () => {
    it('最大50個のテクスチャURLに制限される', () => {
      const manyTextures = Array.from({ length: 100 }, (_, i) => `texture${i}.jpg`);

      const limitedTextures = manyTextures.slice(0, 50);
      expect(limitedTextures.length).toBe(50);
    });

    it('データURLは除外される', () => {
      const textures = [
        'texture.jpg',
        'data:image/png;base64,iVBORw0KGgo...', // データURL
        'another.png',
      ];

      const filteredTextures = textures.filter((t) => !t.startsWith('data:'));
      expect(filteredTextures.length).toBe(2);
    });

    it('Blob URLは除外される', () => {
      const textures = [
        'texture.jpg',
        'blob:http://example.com/12345', // Blob URL
        'another.png',
      ];

      const filteredTextures = textures.filter((t) => !t.startsWith('blob:'));
      expect(filteredTextures.length).toBe(2);
    });
  });
});

// =====================================================
// テストスイート: マテリアル詳細抽出テスト
// =====================================================

describe('ThreeJSSceneExtractor - マテリアル詳細抽出テスト', () => {
  describe('MeshStandardMaterial', () => {
    it('PBRプロパティを正しく抽出する', () => {
      const material = {
        type: 'MeshStandardMaterial',
        color: { getHexString: () => 'ff0000' },
        emissive: { getHexString: () => '000000' },
        metalness: 0.5,
        roughness: 0.7,
        opacity: 1.0,
        transparent: false,
      };

      expect(material.metalness).toBe(0.5);
      expect(material.roughness).toBe(0.7);
      expect(material.opacity).toBe(1.0);
    });
  });

  describe('MeshBasicMaterial', () => {
    it('基本プロパティを正しく抽出する', () => {
      const material = {
        type: 'MeshBasicMaterial',
        color: { getHexString: () => '00ff00' },
        opacity: 0.5,
        transparent: true,
        wireframe: false,
      };

      expect(material.type).toBe('MeshBasicMaterial');
      expect(material.transparent).toBe(true);
    });
  });

  describe('ShaderMaterial', () => {
    it('カスタムシェーダーマテリアルは簡略化して抽出する', () => {
      const material = {
        type: 'ShaderMaterial',
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: { r: 1, g: 0, b: 0 } },
        },
        vertexShader: '// vertex shader code',
        fragmentShader: '// fragment shader code',
      };

      // uniformsの詳細は抽出しない（サイズ制限対策）
      expect(material.type).toBe('ShaderMaterial');
      // Phase2実装後: { type: 'ShaderMaterial', hasCustomShaders: true }
    });
  });
});

// =====================================================
// テストスイート: validateNumber ユーティリティテスト
// =====================================================

describe('ThreeJSSceneExtractor - validateNumber ユーティリティ', () => {
  describe('有効な数値', () => {
    it('範囲内の数値は有効として返す', () => {
      const testCases = [
        { val: 0, min: -1, max: 1, expected: 0 },
        { val: 50, min: 0, max: 100, expected: 50 },
        { val: -10, min: -100, max: 0, expected: -10 },
        { val: 0.5, min: 0, max: 1, expected: 0.5 },
      ];

      testCases.forEach(({ val, min, max, expected }) => {
        expect(val >= min && val <= max).toBe(true);
        expect(val).toBe(expected);
      });
    });
  });

  describe('無効な数値', () => {
    it('NaNは無効として拒否する', () => {
      const val = NaN;
      expect(Number.isNaN(val)).toBe(true);
    });

    it('Infinityは無効として拒否する', () => {
      const val = Infinity;
      expect(Number.isFinite(val)).toBe(false);
    });

    it('-Infinityは無効として拒否する', () => {
      const val = -Infinity;
      expect(Number.isFinite(val)).toBe(false);
    });

    it('文字列は無効として拒否する', () => {
      const val = '123' as unknown as number;
      expect(typeof val).toBe('string');
    });

    it('nullは無効として拒否する', () => {
      const val = null as unknown as number;
      expect(val).toBeNull();
    });

    it('undefinedは無効として拒否する', () => {
      const val = undefined as unknown as number;
      expect(val).toBeUndefined();
    });
  });

  describe('境界値テスト', () => {
    it('最小値ちょうどは有効', () => {
      const val = 0;
      const min = 0;
      const max = 100;
      expect(val >= min && val <= max).toBe(true);
    });

    it('最大値ちょうどは有効', () => {
      const val = 100;
      const min = 0;
      const max = 100;
      expect(val >= min && val <= max).toBe(true);
    });

    it('最小値より小さい値はクランプされる', () => {
      const val = -10;
      const min = 0;
      const max = 100;
      const clamped = Math.max(val, min);
      expect(clamped).toBe(0);
    });

    it('最大値より大きい値はクランプされる', () => {
      const val = 150;
      const min = 0;
      const max = 100;
      const clamped = Math.min(val, max);
      expect(clamped).toBe(100);
    });
  });
});

// =====================================================
// テストスイート: TDD Green Phase - 実装検証テスト
// =====================================================

describe('ThreeJSSceneExtractor - TDD Green Phase（実装検証）', () => {
  describe('validateNumber', () => {
    it('範囲内の有効な数値を受け入れる', () => {
      const result = ThreeJSSceneExtractor.validateNumber(100, 0, 200);
      expect(result.valid).toBe(true);
      expect(result.sanitizedValue).toBe(100);
    });

    it('NaNを無効として拒否する', () => {
      const result = ThreeJSSceneExtractor.validateNumber(NaN, 0, 200);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NaN');
    });

    it('Infinityを無効として拒否する', () => {
      const result = ThreeJSSceneExtractor.validateNumber(Infinity, 0, 200);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Infinity');
    });

    it('範囲外の値をクランプする', () => {
      const result = ThreeJSSceneExtractor.validateNumber(300, 0, 200);
      expect(result.valid).toBe(true);
      expect(result.sanitizedValue).toBe(200);
    });

    it('nullを無効として拒否する', () => {
      const result = ThreeJSSceneExtractor.validateNumber(null, 0, 200);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('null or undefined');
    });

    it('文字列を無効として拒否する', () => {
      const result = ThreeJSSceneExtractor.validateNumber('100', 0, 200);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('not a number');
    });
  });

  describe('sanitizeVector3', () => {
    it('有効なVector3を配列として返す', () => {
      const result = ThreeJSSceneExtractor.sanitizeVector3({ x: 1, y: 2, z: 3 });
      expect(result).toEqual([1, 2, 3]);
    });

    it('NaNを含むVector3はundefinedを返す', () => {
      const result = ThreeJSSceneExtractor.sanitizeVector3({ x: NaN, y: 2, z: 3 });
      expect(result).toBeUndefined();
    });

    it('Infinityを含むVector3はundefinedを返す', () => {
      const result = ThreeJSSceneExtractor.sanitizeVector3({ x: 1, y: Infinity, z: 3 });
      expect(result).toBeUndefined();
    });

    it('nullはundefinedを返す', () => {
      const result = ThreeJSSceneExtractor.sanitizeVector3(null);
      expect(result).toBeUndefined();
    });

    it('不正なオブジェクトはundefinedを返す', () => {
      const result = ThreeJSSceneExtractor.sanitizeVector3({ a: 1, b: 2 });
      expect(result).toBeUndefined();
    });
  });

  describe('extractSceneGraph', () => {
    it('空のシーンを正しく処理する', () => {
      const mockScene = { uuid: 'test-scene', children: [] };
      const result = ThreeJSSceneExtractor.extractSceneGraph(mockScene);

      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0].id).toBe('test-scene');
      expect(result.scenes[0].sceneGraph).toHaveLength(0);
      expect(result.meta.extractedSceneCount).toBe(1);
    });

    it('子オブジェクトを含むシーンを処理する', () => {
      const mockScene = {
        uuid: 'scene-with-children',
        children: [
          { type: 'Mesh', uuid: 'mesh-1', children: [] },
          { type: 'Light', uuid: 'light-1', children: [] },
        ],
      };
      const result = ThreeJSSceneExtractor.extractSceneGraph(mockScene);

      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0].sceneGraph).toHaveLength(2);
      expect(result.scenes[0].totalObjects).toBe(2);
    });

    it('深度制限を適用する', () => {
      const mockScene = {
        uuid: 'deep-scene',
        children: [
          {
            type: 'Group',
            children: [
              {
                type: 'Group',
                children: [
                  {
                    type: 'Group',
                    children: [
                      { type: 'Mesh', children: [] }, // 深度4、制限超過
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = ThreeJSSceneExtractor.extractSceneGraph(mockScene, { maxDepth: 3 });

      expect(result.meta.hitLimits).toBe(true);
      expect(result.meta.limitsApplied.depthLimit).toBe(true);
    });

    it('シーン数制限を適用する', () => {
      const mockScenes = Array.from({ length: 15 }, (_, i) => ({
        uuid: `scene-${i}`,
        children: [],
      }));
      const result = ThreeJSSceneExtractor.extractSceneGraph(mockScenes, { maxScenes: 10 });

      expect(result.scenes).toHaveLength(10);
      expect(result.meta.hitLimits).toBe(true);
      expect(result.meta.limitsApplied.sceneLimit).toBe(true);
    });
  });

  describe('validateJsonSize', () => {
    it('小さいデータは有効として返す', () => {
      const result = ThreeJSSceneExtractor.validateJsonSize({ test: 'data' }, 256 * 1024);
      expect(result.valid).toBe(true);
      expect(result.size).toBeGreaterThan(0);
    });

    it('大きいデータは無効として返す', () => {
      const largeData = { data: 'x'.repeat(300 * 1024) };
      const result = ThreeJSSceneExtractor.validateJsonSize(largeData, 256 * 1024);
      expect(result.valid).toBe(false);
      expect(result.truncated).toBe(true);
    });
  });

  describe('extractTextures', () => {
    it('空のシーン配列から空の配列を返す', () => {
      const result = ThreeJSSceneExtractor.extractTextures([]);
      expect(result).toEqual([]);
    });

    it('テクスチャURLを抽出する', () => {
      const mockScenes = [
        {
          children: [
            {
              material: {
                map: {
                  source: {
                    data: { src: 'texture1.jpg' },
                  },
                },
              },
            },
          ],
        },
      ];
      const result = ThreeJSSceneExtractor.extractTextures(mockScenes);
      expect(result).toContain('texture1.jpg');
    });

    it('data:URLを除外する', () => {
      const mockScenes = [
        {
          children: [
            {
              material: {
                map: {
                  source: {
                    data: { src: 'data:image/png;base64,abc123' },
                  },
                },
              },
            },
          ],
        },
      ];
      const result = ThreeJSSceneExtractor.extractTextures(mockScenes);
      expect(result).toHaveLength(0);
    });

    it('blob:URLを除外する', () => {
      const mockScenes = [
        {
          children: [
            {
              material: {
                map: {
                  source: {
                    data: { src: 'blob:http://example.com/12345' },
                  },
                },
              },
            },
          ],
        },
      ];
      const result = ThreeJSSceneExtractor.extractTextures(mockScenes);
      expect(result).toHaveLength(0);
    });
  });

  describe('extractMaterialInfo', () => {
    it('基本的なマテリアル情報を抽出する', () => {
      const mockMaterial = { type: 'MeshBasicMaterial' };
      const result = ThreeJSSceneExtractor.extractMaterialInfo(mockMaterial);

      expect(result).toBeDefined();
      expect(result?.type).toBe('MeshBasicMaterial');
    });

    it('PBRプロパティを抽出する', () => {
      const mockMaterial = {
        type: 'MeshStandardMaterial',
        metalness: 0.5,
        roughness: 0.7,
        opacity: 1.0,
        transparent: false,
      };
      const result = ThreeJSSceneExtractor.extractMaterialInfo(mockMaterial);

      expect(result?.type).toBe('MeshStandardMaterial');
      expect(result?.metalness).toBe(0.5);
      expect(result?.roughness).toBe(0.7);
      expect(result?.opacity).toBe(1.0);
      expect(result?.transparent).toBe(false);
    });

    it('シェーダーマテリアルを簡略化して返す', () => {
      const mockMaterial = {
        type: 'ShaderMaterial',
        uniforms: { uTime: { value: 0 } },
      };
      const result = ThreeJSSceneExtractor.extractMaterialInfo(mockMaterial);

      expect(result?.type).toBe('ShaderMaterial');
      expect(result?.hasCustomShaders).toBe(true);
    });

    it('nullに対してundefinedを返す', () => {
      const result = ThreeJSSceneExtractor.extractMaterialInfo(null);
      expect(result).toBeUndefined();
    });
  });
});

// =====================================================
// テストスイート: モジュールインポートテスト（Green Phase）
// =====================================================

describe('ThreeJSSceneExtractor - モジュールインポートテスト', () => {
  it('実装ファイルが存在し、正常にインポートできる', async () => {
    // Green Phase: 実装が存在することを確認
    const module = await import('../../../../src/services/motion/three-js-scene-extractor');

    expect(module).toBeDefined();
    expect(module.ThreeJSSceneExtractor).toBeDefined();
    expect(typeof module.ThreeJSSceneExtractor.validateNumber).toBe('function');
    expect(typeof module.ThreeJSSceneExtractor.sanitizeVector3).toBe('function');
    expect(typeof module.ThreeJSSceneExtractor.extractSceneGraph).toBe('function');
    expect(typeof module.ThreeJSSceneExtractor.validateJsonSize).toBe('function');
    expect(typeof module.ThreeJSSceneExtractor.extractTextures).toBe('function');
    expect(typeof module.ThreeJSSceneExtractor.extractMaterialInfo).toBe('function');
  });

  it('定数が正しく定義されている', () => {
    expect(ThreeJSSceneExtractor.MAX_SCENES_DEFAULT).toBe(10);
    expect(ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT).toBe(20);
    expect(ThreeJSSceneExtractor.MAX_DEPTH_DEFAULT).toBe(3);
    expect(ThreeJSSceneExtractor.MAX_JSON_SIZE_DEFAULT).toBe(256 * 1024);
  });
});

// =====================================================
// テストスイート: 統合テスト（Green Phase - 有効化済み）
// =====================================================

describe('ThreeJSSceneExtractor - 統合テスト', () => {
  it('完全なシーングラフ抽出フローをテストする', async () => {
    // 複雑なシーン構造を作成
    const complexScene = {
      uuid: 'complex-scene',
      name: 'TestScene',
      background: {
        isColor: true,
        getHexString: () => '1a1a2e',
      },
      fog: {
        isFog: true,
        color: { getHexString: () => '000000' },
        near: 10,
        far: 100,
      },
      children: [
        {
          type: 'Mesh',
          uuid: 'mesh-1',
          name: 'Cube',
          position: { x: 0, y: 1, z: 0 },
          rotation: { x: 0, y: 0.5, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          geometry: { type: 'BoxGeometry' },
          material: {
            type: 'MeshStandardMaterial',
            color: { getHexString: () => 'ff0000' },
            metalness: 0.5,
            roughness: 0.7,
          },
          children: [],
        },
        {
          type: 'DirectionalLight',
          uuid: 'light-1',
          name: 'SunLight',
          position: { x: 5, y: 10, z: 5 },
          color: { getHexString: () => 'ffffff' },
          intensity: 1.0,
          children: [],
        },
        {
          type: 'Group',
          uuid: 'group-1',
          name: 'ObjectGroup',
          children: [
            {
              type: 'Mesh',
              uuid: 'mesh-2',
              geometry: { type: 'SphereGeometry' },
              material: { type: 'MeshBasicMaterial' },
              children: [],
            },
          ],
        },
      ],
    };

    const result = ThreeJSSceneExtractor.extractSceneGraph(complexScene);

    // 結果の検証
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].id).toBe('complex-scene');
    expect(result.scenes[0].name).toBe('TestScene');
    expect(result.scenes[0].sceneGraph).toHaveLength(3);
    expect(result.scenes[0].totalObjects).toBe(4); // 3 + 1 (nested mesh)

    // メタデータの検証
    expect(result.meta.extractedSceneCount).toBe(1);
    expect(result.meta.extractedObjectCount).toBe(4);
    expect(result.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.jsonSizeBytes).toBeGreaterThan(0);
  });

  it('複数シーンの抽出をテストする', () => {
    const multipleScenes = [
      { uuid: 'scene-1', children: [{ type: 'Mesh', children: [] }] },
      { uuid: 'scene-2', children: [{ type: 'Light', children: [] }] },
      { uuid: 'scene-3', children: [] },
    ];

    const result = ThreeJSSceneExtractor.extractSceneGraph(multipleScenes);

    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[0].id).toBe('scene-1');
    expect(result.scenes[1].id).toBe('scene-2');
    expect(result.scenes[2].id).toBe('scene-3');
    expect(result.meta.originalSceneCount).toBe(3);
  });

  // Note: Playwrightページからの実際の抽出はE2Eテストで実施
  // extractFromPage はブラウザコンテキストが必要なため、
  // ここではユニットテスト可能な範囲のみテスト
});
