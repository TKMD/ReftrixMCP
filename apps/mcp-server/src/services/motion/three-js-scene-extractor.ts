// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Three.jsシーングラフ抽出サービス
 *
 * WebGL/Three.jsベースのWebページからシーングラフ情報を安全に抽出します。
 *
 * 機能:
 * - 再帰的シーングラフ抽出（深度制限: 3階層）
 * - セキュリティ制限（シーン数、オブジェクト数、JSONBサイズ）
 * - 数値範囲検証（NaN, Infinity対策）
 * - フォールバック動作（__THREE_DEVTOOLS__なし）
 *
 * セキュリティ要件:
 * - シーン数・オブジェクト数・JSONBサイズの上限制限
 * - 数値範囲検証（NaN, Infinity対策）
 *
 * @module services/motion/three-js-scene-extractor
 */

import type { Page } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * 数値検証ユーティリティ結果
 */
export interface NumberValidationResult {
  valid: boolean;
  sanitizedValue?: number;
  reason?: string;
}

/**
 * シーングラフ抽出オプション
 */
export interface SceneGraphExtractOptions {
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
 * マテリアル詳細情報
 */
export interface MaterialInfo {
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
  /** カスタムシェーダーフラグ */
  hasCustomShaders?: boolean;
  /** ワイヤーフレームフラグ */
  wireframe?: boolean;
}

/**
 * 再帰的シーングラフノード
 */
export interface SceneGraphNode {
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
  /** InstancedMesh: インスタンス数 */
  instanceCount?: number;
  /** SkinnedMesh: ボーン数 */
  boneCount?: number;
}

/**
 * 拡張シーン情報
 */
export interface ExtendedSceneInfo {
  /** シーンID */
  id: string;
  /** シーン名 */
  name?: string;
  /** 背景色 (hex) */
  background?: string;
  /** フォグ設定 */
  fog?: {
    /** フォグタイプ (Fog | FogExp2) */
    type: string;
    /** フォグ色 (hex) */
    color: string;
    /** 密度 (FogExp2の場合) */
    density?: number;
    /** 開始距離 (Fogの場合) */
    near?: number;
    /** 終了距離 (Fogの場合) */
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
export interface SceneGraphExtractionResult {
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

// =====================================================
// ThreeJSSceneExtractor クラス
// =====================================================

/**
 * Three.jsシーングラフ抽出サービス
 *
 * Playwrightページからシーングラフ情報を安全に抽出します。
 * セキュリティ上の制限（深度、オブジェクト数、JSONサイズ）を厳守します。
 */
export class ThreeJSSceneExtractor {
  // =====================================================
  // 定数
  // =====================================================

  /** シーン数の最大値（デフォルト） */
  static readonly MAX_SCENES_DEFAULT = 10;
  /** 子オブジェクト数の最大値（デフォルト） */
  static readonly MAX_CHILDREN_DEFAULT = 20;
  /** ネスト深度の最大値（デフォルト） */
  static readonly MAX_DEPTH_DEFAULT = 3;
  /** JSONBサイズの最大値（デフォルト: 256KB） */
  static readonly MAX_JSON_SIZE_DEFAULT = 256 * 1024;
  /** テクスチャURLの最大数 */
  static readonly MAX_TEXTURES_DEFAULT = 50;

  // =====================================================
  // 数値検証ユーティリティ
  // =====================================================

  /**
   * 数値を検証し、範囲内に収める
   *
   * @param val - 検証する値
   * @param min - 最小値
   * @param max - 最大値
   * @returns 検証結果
   */
  static validateNumber(
    val: unknown,
    min: number,
    max: number
  ): NumberValidationResult {
    // null/undefined チェック
    if (val === null || val === undefined) {
      return { valid: false, reason: 'null or undefined' };
    }

    // 型チェック
    if (typeof val !== 'number') {
      return { valid: false, reason: 'not a number' };
    }

    // NaN チェック
    if (Number.isNaN(val)) {
      return { valid: false, reason: 'NaN' };
    }

    // Infinity チェック
    if (!Number.isFinite(val)) {
      return { valid: false, reason: 'Infinity' };
    }

    // 範囲チェック（クランプ）
    const clamped = Math.min(Math.max(val, min), max);
    return {
      valid: true,
      sanitizedValue: clamped,
    };
  }

  /**
   * Vector3を安全に抽出
   *
   * @param vec - 検証するベクトル
   * @returns 安全なベクトル配列またはundefined
   */
  static sanitizeVector3(vec: unknown): [number, number, number] | undefined {
    if (!vec || typeof vec !== 'object') {
      return undefined;
    }

    const obj = vec as Record<string, unknown>;

    // x, y, z が存在するか確認
    if (!('x' in obj) || !('y' in obj) || !('z' in obj)) {
      return undefined;
    }

    const xResult = ThreeJSSceneExtractor.validateNumber(obj.x, -1e10, 1e10);
    const yResult = ThreeJSSceneExtractor.validateNumber(obj.y, -1e10, 1e10);
    const zResult = ThreeJSSceneExtractor.validateNumber(obj.z, -1e10, 1e10);

    if (!xResult.valid || !yResult.valid || !zResult.valid) {
      return undefined;
    }

    return [xResult.sanitizedValue!, yResult.sanitizedValue!, zResult.sanitizedValue!];
  }

  // =====================================================
  // シーングラフ抽出
  // =====================================================

  /**
   * 再帰的にシーングラフを抽出
   *
   * @param obj - Three.jsオブジェクト
   * @param options - 抽出オプション
   * @param currentDepth - 現在の深度
   * @param visitedSet - 循環参照検出用のUUIDセット
   * @returns 抽出結果
   */
  static extractSceneGraphNode(
    obj: unknown,
    options: Required<SceneGraphExtractOptions>,
    currentDepth: number,
    visitedSet: Set<string>
  ): { node: SceneGraphNode | null; objectCount: number; truncated: boolean } {
    // 深度制限チェック
    if (currentDepth > options.maxDepth) {
      return {
        node: { type: 'Group', truncated: true, depth: currentDepth },
        objectCount: 0,
        truncated: true,
      };
    }

    if (!obj || typeof obj !== 'object') {
      return { node: null, objectCount: 0, truncated: false };
    }

    const threeObj = obj as Record<string, unknown>;

    // UUIDベースの循環参照検出
    const uuid = typeof threeObj.uuid === 'string' ? threeObj.uuid : undefined;
    if (uuid) {
      if (visitedSet.has(uuid)) {
        // 循環参照検出
        return {
          node: { type: 'CircularReference', truncated: true },
          objectCount: 0,
          truncated: true,
        };
      }
      visitedSet.add(uuid);
    }

    // オブジェクトタイプを取得
    const type = typeof threeObj.type === 'string' ? threeObj.type : 'Object3D';

    // 基本ノード構築
    const node: SceneGraphNode = {
      type,
      depth: currentDepth,
    };

    // 名前
    if (typeof threeObj.name === 'string' && threeObj.name !== '') {
      node.name = threeObj.name;
    }

    // UUID
    if (uuid) {
      node.uuid = uuid;
    }

    // 位置
    const position = ThreeJSSceneExtractor.sanitizeVector3(threeObj.position);
    if (position) {
      node.position = position;
    }

    // 回転
    const rotation = ThreeJSSceneExtractor.sanitizeVector3(threeObj.rotation);
    if (rotation) {
      node.rotation = rotation;
    }

    // スケール
    const scale = ThreeJSSceneExtractor.sanitizeVector3(threeObj.scale);
    if (scale) {
      node.scale = scale;
    }

    // ジオメトリ情報
    if (threeObj.geometry && typeof threeObj.geometry === 'object') {
      const geo = threeObj.geometry as Record<string, unknown>;
      node.geometry = typeof geo.type === 'string' ? geo.type : 'BufferGeometry';
    }

    // マテリアル情報
    if (threeObj.material && options.extractMaterialDetails) {
      const mat = ThreeJSSceneExtractor.extractMaterialInfo(threeObj.material);
      if (mat) {
        node.material = mat;
      }
    }

    // ライト固有情報
    if (type.includes('Light')) {
      if (threeObj.color && typeof threeObj.color === 'object') {
        const color = threeObj.color as Record<string, unknown>;
        if (typeof color.getHexString === 'function') {
          try {
            node.color = `#${(color.getHexString as () => string)()}`;
          } catch {
            // getHexString失敗は無視
          }
        }
      }

      const intensityResult = ThreeJSSceneExtractor.validateNumber(
        threeObj.intensity,
        0,
        1000
      );
      if (intensityResult.valid && intensityResult.sanitizedValue !== undefined) {
        node.intensity = intensityResult.sanitizedValue;
      }
    }

    // InstancedMesh固有
    if (type === 'InstancedMesh' || threeObj.isInstancedMesh === true) {
      const countResult = ThreeJSSceneExtractor.validateNumber(
        threeObj.count,
        0,
        1e6
      );
      if (countResult.valid && countResult.sanitizedValue !== undefined) {
        node.instanceCount = countResult.sanitizedValue;
      }
    }

    // SkinnedMesh固有
    if (type === 'SkinnedMesh' || threeObj.isSkinnedMesh === true) {
      if (threeObj.skeleton && typeof threeObj.skeleton === 'object') {
        const skeleton = threeObj.skeleton as Record<string, unknown>;
        if (Array.isArray(skeleton.bones)) {
          node.boneCount = skeleton.bones.length;
        }
      }
    }

    let totalObjectCount = 1;
    let wasTruncated = false;

    // 子オブジェクト処理
    if (Array.isArray(threeObj.children) && threeObj.children.length > 0) {
      const children = threeObj.children.slice(0, options.maxChildrenPerScene);
      wasTruncated = threeObj.children.length > options.maxChildrenPerScene;

      node.children = [];

      for (const child of children) {
        const childResult = ThreeJSSceneExtractor.extractSceneGraphNode(
          child,
          options,
          currentDepth + 1,
          visitedSet
        );

        if (childResult.node) {
          node.children.push(childResult.node);
          totalObjectCount += childResult.objectCount;
          wasTruncated = wasTruncated || childResult.truncated;
        }
      }
    } else if (threeObj.children !== undefined && !Array.isArray(threeObj.children)) {
      // childrenが配列でない場合は空配列として扱う
      node.children = [];
    }

    if (wasTruncated) {
      node.truncated = true;
    }

    return { node, objectCount: totalObjectCount, truncated: wasTruncated };
  }

  /**
   * シーングラフ抽出（単一シーン）
   */
  static extractSceneGraph(
    scene: unknown,
    options?: SceneGraphExtractOptions
  ): SceneGraphExtractionResult {
    const startTime = Date.now();

    const opts: Required<SceneGraphExtractOptions> = {
      maxScenes: options?.maxScenes ?? ThreeJSSceneExtractor.MAX_SCENES_DEFAULT,
      maxChildrenPerScene:
        options?.maxChildrenPerScene ?? ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT,
      maxDepth: options?.maxDepth ?? ThreeJSSceneExtractor.MAX_DEPTH_DEFAULT,
      maxJsonSize: options?.maxJsonSize ?? ThreeJSSceneExtractor.MAX_JSON_SIZE_DEFAULT,
      extractTextures: options?.extractTextures ?? true,
      extractMaterialDetails: options?.extractMaterialDetails ?? true,
    };

    const errors: string[] = [];
    const limitsApplied = {
      sceneLimit: false,
      childrenLimit: false,
      depthLimit: false,
      sizeLimit: false,
    };

    // 配列として扱う
    const scenesInput = Array.isArray(scene) ? scene : [scene];
    const originalSceneCount = scenesInput.length;

    // シーン数制限
    const limitedScenes = scenesInput.slice(0, opts.maxScenes);
    limitsApplied.sceneLimit = scenesInput.length > opts.maxScenes;

    const extractedScenes: ExtendedSceneInfo[] = [];
    let totalOriginalObjects = 0;
    let totalExtractedObjects = 0;

    for (let i = 0; i < limitedScenes.length; i++) {
      const sceneObj = limitedScenes[i];
      if (!sceneObj || typeof sceneObj !== 'object') {
        continue;
      }

      const threeScene = sceneObj as Record<string, unknown>;
      const visitedSet = new Set<string>();

      // シーンID
      const sceneId =
        typeof threeScene.uuid === 'string' ? threeScene.uuid : `scene-${i}`;

      // シーン名
      const sceneName =
        typeof threeScene.name === 'string' && threeScene.name !== ''
          ? threeScene.name
          : undefined;

      // 背景色
      let background: string | undefined;
      if (threeScene.background && typeof threeScene.background === 'object') {
        const bg = threeScene.background as Record<string, unknown>;
        if (bg.isColor && typeof bg.getHexString === 'function') {
          try {
            background = `#${(bg.getHexString as () => string)()}`;
          } catch {
            // 取得失敗は無視
          }
        }
      }

      // フォグ情報
      let fog: ExtendedSceneInfo['fog'];
      if (threeScene.fog && typeof threeScene.fog === 'object') {
        const fogObj = threeScene.fog as Record<string, unknown>;
        const fogColor = fogObj.color as Record<string, unknown> | undefined;

        let fogColorHex = '#000000';
        if (fogColor && typeof fogColor.getHexString === 'function') {
          try {
            fogColorHex = `#${(fogColor.getHexString as () => string)()}`;
          } catch {
            // 取得失敗は無視
          }
        }

        fog = {
          type: fogObj.isFogExp2 === true ? 'FogExp2' : 'Fog',
          color: fogColorHex,
        };

        // FogExp2のdensity
        if (typeof fogObj.density === 'number' && Number.isFinite(fogObj.density)) {
          fog.density = fogObj.density;
        }

        // Fogのnear/far
        if (typeof fogObj.near === 'number' && Number.isFinite(fogObj.near)) {
          fog.near = fogObj.near;
        }
        if (typeof fogObj.far === 'number' && Number.isFinite(fogObj.far)) {
          fog.far = fogObj.far;
        }
      }

      // 子オブジェクト抽出
      const sceneGraph: SceneGraphNode[] = [];
      let sceneObjectCount = 0;
      let sceneTruncated = false;

      if (Array.isArray(threeScene.children)) {
        totalOriginalObjects += ThreeJSSceneExtractor.countObjects(threeScene);

        const children = threeScene.children.slice(0, opts.maxChildrenPerScene);
        limitsApplied.childrenLimit =
          limitsApplied.childrenLimit || threeScene.children.length > opts.maxChildrenPerScene;

        for (const child of children) {
          const result = ThreeJSSceneExtractor.extractSceneGraphNode(
            child,
            opts,
            1,
            visitedSet
          );

          if (result.node) {
            sceneGraph.push(result.node);
            sceneObjectCount += result.objectCount;
            sceneTruncated = sceneTruncated || result.truncated;
          }
        }
      }

      limitsApplied.depthLimit = limitsApplied.depthLimit || sceneTruncated;
      totalExtractedObjects += sceneObjectCount;

      const extendedScene: ExtendedSceneInfo = {
        id: sceneId,
        sceneGraph,
        totalObjects: sceneObjectCount,
        wasTruncated: sceneTruncated,
      };

      if (sceneName !== undefined) {
        extendedScene.name = sceneName;
      }
      if (background !== undefined) {
        extendedScene.background = background;
      }
      if (fog !== undefined) {
        extendedScene.fog = fog;
      }

      extractedScenes.push(extendedScene);
    }

    // JSONサイズ検証
    const jsonStr = JSON.stringify({ scenes: extractedScenes });
    const jsonSizeBytes = new TextEncoder().encode(jsonStr).length;

    // サイズ超過時の処理
    if (jsonSizeBytes > opts.maxJsonSize) {
      limitsApplied.sizeLimit = true;
      errors.push(
        `JSON size (${jsonSizeBytes} bytes) exceeds limit (${opts.maxJsonSize} bytes). Consider reducing depth or children limits.`
      );
    }

    const processingTimeMs = Date.now() - startTime;

    const result: SceneGraphExtractionResult = {
      scenes: extractedScenes,
      textures: [],
      meta: {
        processingTimeMs,
        originalSceneCount,
        extractedSceneCount: extractedScenes.length,
        originalObjectCount: totalOriginalObjects,
        extractedObjectCount: totalExtractedObjects,
        jsonSizeBytes,
        hitLimits:
          limitsApplied.sceneLimit ||
          limitsApplied.childrenLimit ||
          limitsApplied.depthLimit ||
          limitsApplied.sizeLimit,
        limitsApplied,
      },
    };

    if (errors.length > 0) {
      result.errors = errors;
    }

    return result;
  }

  /**
   * オブジェクト総数をカウント
   */
  private static countObjects(obj: unknown): number {
    if (!obj || typeof obj !== 'object') {
      return 0;
    }

    const threeObj = obj as Record<string, unknown>;
    let count = 1;

    if (Array.isArray(threeObj.children)) {
      for (const child of threeObj.children) {
        count += ThreeJSSceneExtractor.countObjects(child);
      }
    }

    return count;
  }

  // =====================================================
  // JSONサイズ検証
  // =====================================================

  /**
   * JSONサイズを検証
   *
   * @param data - 検証するデータ
   * @param maxSize - 最大サイズ（バイト）
   * @returns 検証結果
   */
  static validateJsonSize(
    data: unknown,
    maxSize: number
  ): { valid: boolean; size: number; truncated?: boolean } {
    try {
      const jsonStr = JSON.stringify(data);
      const size = new TextEncoder().encode(jsonStr).length;

      return {
        valid: size <= maxSize,
        size,
        truncated: size > maxSize,
      };
    } catch {
      return { valid: false, size: 0, truncated: true };
    }
  }

  // =====================================================
  // テクスチャ抽出
  // =====================================================

  /**
   * シーンからテクスチャURLを抽出
   *
   * @param scenes - シーン配列
   * @returns テクスチャURL配列（重複なし、最大50個）
   */
  static extractTextures(scenes: unknown[]): string[] {
    const textureUrls = new Set<string>();

    const extractFromObject = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      const threeObj = obj as Record<string, unknown>;

      // マテリアルからテクスチャを抽出
      if (threeObj.material) {
        ThreeJSSceneExtractor.extractTexturesFromMaterial(
          threeObj.material,
          textureUrls
        );
      }

      // 子オブジェクトを再帰的に処理
      if (Array.isArray(threeObj.children)) {
        for (const child of threeObj.children) {
          extractFromObject(child);
        }
      }
    };

    for (const scene of scenes) {
      if (scene && typeof scene === 'object') {
        const sceneObj = scene as Record<string, unknown>;

        // シーン直下のオブジェクト
        if (Array.isArray(sceneObj.children)) {
          for (const child of sceneObj.children) {
            extractFromObject(child);
          }
        }
      }
    }

    // フィルタリング（data:, blob: を除外）
    const filteredUrls = Array.from(textureUrls)
      .filter((url) => !url.startsWith('data:') && !url.startsWith('blob:'))
      .slice(0, ThreeJSSceneExtractor.MAX_TEXTURES_DEFAULT);

    return filteredUrls;
  }

  /**
   * マテリアルからテクスチャURLを抽出
   */
  private static extractTexturesFromMaterial(
    material: unknown,
    textureUrls: Set<string>
  ): void {
    if (!material || typeof material !== 'object') {
      return;
    }

    const mat = material as Record<string, unknown>;
    const textureProps = ['map', 'normalMap', 'envMap', 'aoMap', 'emissiveMap', 'roughnessMap', 'metalnessMap'];

    for (const prop of textureProps) {
      if (mat[prop] && typeof mat[prop] === 'object') {
        const texture = mat[prop] as Record<string, unknown>;

        // source.data.src からURL取得
        if (texture.source && typeof texture.source === 'object') {
          const source = texture.source as Record<string, unknown>;
          if (source.data && typeof source.data === 'object') {
            const data = source.data as Record<string, unknown>;
            if (typeof data.src === 'string' && data.src.length > 0) {
              textureUrls.add(data.src);
            }
          }
        }

        // image.src からURL取得（代替パス）
        if (texture.image && typeof texture.image === 'object') {
          const image = texture.image as Record<string, unknown>;
          if (typeof image.src === 'string' && image.src.length > 0) {
            textureUrls.add(image.src);
          }
        }

        // name からURL取得（代替パス）
        if (typeof texture.name === 'string' && texture.name.length > 0) {
          // ファイル名のような文字列の場合のみ
          if (texture.name.includes('.')) {
            textureUrls.add(texture.name);
          }
        }
      }
    }

    // 配列マテリアルの場合
    if (Array.isArray(material)) {
      for (const m of material) {
        ThreeJSSceneExtractor.extractTexturesFromMaterial(m, textureUrls);
      }
    }
  }

  // =====================================================
  // マテリアル情報抽出
  // =====================================================

  /**
   * マテリアル情報を抽出
   *
   * @param material - Three.jsマテリアルオブジェクト
   * @returns マテリアル情報またはundefined
   */
  static extractMaterialInfo(material: unknown): MaterialInfo | undefined {
    if (!material || typeof material !== 'object') {
      return undefined;
    }

    const mat = material as Record<string, unknown>;
    const type = typeof mat.type === 'string' ? mat.type : 'Material';

    const info: MaterialInfo = { type };

    // シェーダーマテリアルの場合は簡略化
    if (type === 'ShaderMaterial' || type === 'RawShaderMaterial') {
      info.hasCustomShaders = true;
      return info;
    }

    // 色
    if (mat.color && typeof mat.color === 'object') {
      const color = mat.color as Record<string, unknown>;
      if (typeof color.getHexString === 'function') {
        try {
          info.color = `#${(color.getHexString as () => string)()}`;
        } catch {
          // 取得失敗は無視
        }
      }
    }

    // 放射色
    if (mat.emissive && typeof mat.emissive === 'object') {
      const emissive = mat.emissive as Record<string, unknown>;
      if (typeof emissive.getHexString === 'function') {
        try {
          info.emissive = `#${(emissive.getHexString as () => string)()}`;
        } catch {
          // 取得失敗は無視
        }
      }
    }

    // 金属度
    const metalnessResult = ThreeJSSceneExtractor.validateNumber(mat.metalness, 0, 1);
    if (metalnessResult.valid && metalnessResult.sanitizedValue !== undefined) {
      info.metalness = metalnessResult.sanitizedValue;
    }

    // 粗さ
    const roughnessResult = ThreeJSSceneExtractor.validateNumber(mat.roughness, 0, 1);
    if (roughnessResult.valid && roughnessResult.sanitizedValue !== undefined) {
      info.roughness = roughnessResult.sanitizedValue;
    }

    // 透明度
    const opacityResult = ThreeJSSceneExtractor.validateNumber(mat.opacity, 0, 1);
    if (opacityResult.valid && opacityResult.sanitizedValue !== undefined) {
      info.opacity = opacityResult.sanitizedValue;
    }

    // 透明フラグ
    if (typeof mat.transparent === 'boolean') {
      info.transparent = mat.transparent;
    }

    // ワイヤーフレームフラグ
    if (typeof mat.wireframe === 'boolean') {
      info.wireframe = mat.wireframe;
    }

    // テクスチャマップ参照
    if (mat.map && typeof mat.map === 'object') {
      const map = mat.map as Record<string, unknown>;
      if (typeof map.name === 'string') {
        info.map = map.name;
      } else if (map.source && typeof map.source === 'object') {
        const source = map.source as Record<string, unknown>;
        if (source.data && typeof source.data === 'object') {
          const data = source.data as Record<string, unknown>;
          if (typeof data.src === 'string') {
            info.map = data.src;
          }
        }
      }
    }

    // ノーマルマップ参照
    if (mat.normalMap && typeof mat.normalMap === 'object') {
      const normalMap = mat.normalMap as Record<string, unknown>;
      if (typeof normalMap.name === 'string') {
        info.normalMap = normalMap.name;
      }
    }

    return info;
  }

  // =====================================================
  // Playwrightページからの抽出
  // =====================================================

  /**
   * Playwrightページからシーングラフを抽出
   *
   * @param page - Playwrightページオブジェクト
   * @param options - 抽出オプション
   * @returns 抽出結果またはnull
   */
  /* eslint-disable no-undef -- page.evaluate() runs in browser context */
  static async extractFromPage(
    page: Page,
    options?: SceneGraphExtractOptions
  ): Promise<SceneGraphExtractionResult | null> {
    const startTime = Date.now();

    const opts: Required<SceneGraphExtractOptions> = {
      maxScenes: options?.maxScenes ?? ThreeJSSceneExtractor.MAX_SCENES_DEFAULT,
      maxChildrenPerScene:
        options?.maxChildrenPerScene ?? ThreeJSSceneExtractor.MAX_CHILDREN_DEFAULT,
      maxDepth: options?.maxDepth ?? ThreeJSSceneExtractor.MAX_DEPTH_DEFAULT,
      maxJsonSize: options?.maxJsonSize ?? ThreeJSSceneExtractor.MAX_JSON_SIZE_DEFAULT,
      extractTextures: options?.extractTextures ?? true,
      extractMaterialDetails: options?.extractMaterialDetails ?? true,
    };

    try {
      const rawData = await page.evaluate(
        (evalOpts: Required<SceneGraphExtractOptions>) => {
          // windowの型拡張
          const win = window as unknown as {
            THREE?: {
              REVISION?: string;
            };
            __THREE_DEVTOOLS__?: {
              scenes?: unknown[];
              renderers?: unknown[];
            };
          };

          // Three.jsが存在しない場合
          if (typeof win.THREE === 'undefined') {
            return null;
          }

          // バージョン取得
          const revision = win.THREE.REVISION;
          const version =
            typeof revision === 'string'
              ? revision.startsWith('r')
                ? revision
                : `r${revision}`
              : undefined;

          // シーン情報収集
          const scenesData: Array<{
            uuid: string;
            name?: string;
            background?: { hex: string };
            fog?: {
              type: string;
              color: string;
              density?: number;
              near?: number;
              far?: number;
            };
            children: unknown[];
            totalChildrenCount: number;
          }> = [];

          let webglContextCount = 0;

          // canvas要素からWebGLコンテキスト数をカウント
          const canvases = document.querySelectorAll('canvas');
          canvases.forEach((canvas) => {
            try {
              const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
              if (gl) {
                webglContextCount++;
              }
            } catch {
              // コンテキスト取得失敗は無視
            }
          });

          // __THREE_DEVTOOLS__から詳細情報を取得
          if (win.__THREE_DEVTOOLS__?.scenes && Array.isArray(win.__THREE_DEVTOOLS__.scenes)) {
            const devtoolScenes = win.__THREE_DEVTOOLS__.scenes.slice(0, evalOpts.maxScenes);

            for (const scene of devtoolScenes) {
              if (!scene || typeof scene !== 'object') {
                continue;
              }

              const sceneObj = scene as Record<string, unknown>;
              const uuid =
                typeof sceneObj.uuid === 'string' ? sceneObj.uuid : `auto-${scenesData.length}`;

              const sceneData: {
                uuid: string;
                name?: string;
                background?: { hex: string };
                fog?: {
                  type: string;
                  color: string;
                  density?: number;
                  near?: number;
                  far?: number;
                };
                children: unknown[];
                totalChildrenCount: number;
              } = {
                uuid,
                children: [],
                totalChildrenCount: 0,
              };

              // 名前
              if (typeof sceneObj.name === 'string' && sceneObj.name !== '') {
                sceneData.name = sceneObj.name;
              }

              // 背景色
              if (sceneObj.background && typeof sceneObj.background === 'object') {
                const bg = sceneObj.background as Record<string, unknown>;
                if (bg.isColor && typeof bg.getHexString === 'function') {
                  try {
                    sceneData.background = { hex: (bg.getHexString as () => string)() };
                  } catch {
                    // 取得失敗は無視
                  }
                }
              }

              // フォグ
              if (sceneObj.fog && typeof sceneObj.fog === 'object') {
                const fogObj = sceneObj.fog as Record<string, unknown>;
                const fogColor = fogObj.color as Record<string, unknown> | undefined;

                let colorHex = '000000';
                if (fogColor && typeof fogColor.getHexString === 'function') {
                  try {
                    colorHex = (fogColor.getHexString as () => string)();
                  } catch {
                    // 取得失敗は無視
                  }
                }

                sceneData.fog = {
                  type: fogObj.isFogExp2 === true ? 'FogExp2' : 'Fog',
                  color: colorHex,
                };

                if (typeof fogObj.density === 'number' && Number.isFinite(fogObj.density)) {
                  sceneData.fog.density = fogObj.density;
                }
                if (typeof fogObj.near === 'number' && Number.isFinite(fogObj.near)) {
                  sceneData.fog.near = fogObj.near;
                }
                if (typeof fogObj.far === 'number' && Number.isFinite(fogObj.far)) {
                  sceneData.fog.far = fogObj.far;
                }
              }

              // 子オブジェクト（シリアライズ可能な形式に変換）
              const serializeObject = (
                obj: unknown,
                depth: number
              ): unknown => {
                if (depth > evalOpts.maxDepth || !obj || typeof obj !== 'object') {
                  return depth > evalOpts.maxDepth ? { truncated: true } : null;
                }

                const threeObj = obj as Record<string, unknown>;
                const result: Record<string, unknown> = {
                  type: typeof threeObj.type === 'string' ? threeObj.type : 'Object3D',
                };

                if (typeof threeObj.uuid === 'string') {
                  result.uuid = threeObj.uuid;
                }
                if (typeof threeObj.name === 'string' && threeObj.name !== '') {
                  result.name = threeObj.name;
                }

                // 位置
                if (threeObj.position && typeof threeObj.position === 'object') {
                  const pos = threeObj.position as Record<string, unknown>;
                  if (
                    typeof pos.x === 'number' &&
                    typeof pos.y === 'number' &&
                    typeof pos.z === 'number' &&
                    Number.isFinite(pos.x) &&
                    Number.isFinite(pos.y) &&
                    Number.isFinite(pos.z)
                  ) {
                    result.position = { x: pos.x, y: pos.y, z: pos.z };
                  }
                }

                // 回転
                if (threeObj.rotation && typeof threeObj.rotation === 'object') {
                  const rot = threeObj.rotation as Record<string, unknown>;
                  if (
                    typeof rot.x === 'number' &&
                    typeof rot.y === 'number' &&
                    typeof rot.z === 'number' &&
                    Number.isFinite(rot.x) &&
                    Number.isFinite(rot.y) &&
                    Number.isFinite(rot.z)
                  ) {
                    result.rotation = { x: rot.x, y: rot.y, z: rot.z };
                  }
                }

                // スケール
                if (threeObj.scale && typeof threeObj.scale === 'object') {
                  const scl = threeObj.scale as Record<string, unknown>;
                  if (
                    typeof scl.x === 'number' &&
                    typeof scl.y === 'number' &&
                    typeof scl.z === 'number' &&
                    Number.isFinite(scl.x) &&
                    Number.isFinite(scl.y) &&
                    Number.isFinite(scl.z)
                  ) {
                    result.scale = { x: scl.x, y: scl.y, z: scl.z };
                  }
                }

                // ジオメトリ
                if (threeObj.geometry && typeof threeObj.geometry === 'object') {
                  const geo = threeObj.geometry as Record<string, unknown>;
                  result.geometry = {
                    type: typeof geo.type === 'string' ? geo.type : 'BufferGeometry',
                  };
                }

                // マテリアル
                if (evalOpts.extractMaterialDetails && threeObj.material) {
                  if (typeof threeObj.material === 'object') {
                    const mat = threeObj.material as Record<string, unknown>;
                    const matData: Record<string, unknown> = {
                      type: typeof mat.type === 'string' ? mat.type : 'Material',
                    };

                    // 色
                    if (mat.color && typeof mat.color === 'object') {
                      const color = mat.color as Record<string, unknown>;
                      if (typeof color.getHexString === 'function') {
                        try {
                          matData.color = (color.getHexString as () => string)();
                        } catch {
                          // 無視
                        }
                      }
                    }

                    // PBRプロパティ
                    if (typeof mat.metalness === 'number' && Number.isFinite(mat.metalness)) {
                      matData.metalness = mat.metalness;
                    }
                    if (typeof mat.roughness === 'number' && Number.isFinite(mat.roughness)) {
                      matData.roughness = mat.roughness;
                    }
                    if (typeof mat.opacity === 'number' && Number.isFinite(mat.opacity)) {
                      matData.opacity = mat.opacity;
                    }
                    if (typeof mat.transparent === 'boolean') {
                      matData.transparent = mat.transparent;
                    }

                    result.material = matData;
                  }
                }

                // ライト固有
                if (result.type && typeof result.type === 'string' && result.type.includes('Light')) {
                  if (threeObj.color && typeof threeObj.color === 'object') {
                    const color = threeObj.color as Record<string, unknown>;
                    if (typeof color.getHexString === 'function') {
                      try {
                        result.lightColor = (color.getHexString as () => string)();
                      } catch {
                        // 無視
                      }
                    }
                  }
                  if (typeof threeObj.intensity === 'number' && Number.isFinite(threeObj.intensity)) {
                    result.intensity = threeObj.intensity;
                  }
                }

                // InstancedMesh
                if (result.type === 'InstancedMesh' || threeObj.isInstancedMesh === true) {
                  if (typeof threeObj.count === 'number' && Number.isFinite(threeObj.count)) {
                    result.instanceCount = threeObj.count;
                  }
                }

                // 子オブジェクト
                if (Array.isArray(threeObj.children) && threeObj.children.length > 0) {
                  const children = threeObj.children.slice(0, evalOpts.maxChildrenPerScene);
                  result.children = children.map((child) =>
                    serializeObject(child, depth + 1)
                  ).filter((c): c is Record<string, unknown> => c !== null);

                  if (threeObj.children.length > evalOpts.maxChildrenPerScene) {
                    result.childrenTruncated = true;
                  }
                }

                return result;
              };

              if (Array.isArray(sceneObj.children)) {
                sceneData.totalChildrenCount = sceneObj.children.length;
                const limitedChildren = sceneObj.children.slice(0, evalOpts.maxChildrenPerScene);
                sceneData.children = limitedChildren
                  .map((child) => serializeObject(child, 1))
                  .filter((c): c is Record<string, unknown> => c !== null);
              }

              scenesData.push(sceneData);
            }
          }

          // __THREE_DEVTOOLS__がない場合、WebGLコンテキスト数に基づいてダミーシーン生成
          if (scenesData.length === 0 && webglContextCount > 0) {
            for (let i = 0; i < Math.min(webglContextCount, evalOpts.maxScenes); i++) {
              scenesData.push({
                uuid: `scene-${i}`,
                children: [],
                totalChildrenCount: 0,
              });
            }
          }

          return {
            version,
            scenesData,
            webglContextCount,
          };
        },
        opts
      );

      if (!rawData) {
        if (isDevelopment()) {
          logger.debug('[ThreeJSSceneExtractor] Three.js not detected on page');
        }
        return null;
      }

      // 抽出結果を構築
      const errors: string[] = [];
      const limitsApplied = {
        sceneLimit: rawData.scenesData.length >= opts.maxScenes,
        childrenLimit: false,
        depthLimit: false,
        sizeLimit: false,
      };

      let totalOriginalObjects = 0;
      let totalExtractedObjects = 0;

      const extractedScenes: ExtendedSceneInfo[] = [];

      for (const sceneData of rawData.scenesData) {
        totalOriginalObjects += sceneData.totalChildrenCount;

        const sceneGraph: SceneGraphNode[] = [];
        let sceneObjectCount = 0;
        let sceneTruncated = false;

        // シリアライズされた子オブジェクトを変換
        const convertToSceneGraphNode = (
          obj: unknown,
          depth: number
        ): { node: SceneGraphNode | null; count: number; truncated: boolean } => {
          if (!obj || typeof obj !== 'object') {
            return { node: null, count: 0, truncated: false };
          }

          const data = obj as Record<string, unknown>;

          if (data.truncated === true) {
            return {
              node: { type: 'Group', truncated: true, depth },
              count: 0,
              truncated: true,
            };
          }

          const node: SceneGraphNode = {
            type: typeof data.type === 'string' ? data.type : 'Object3D',
            depth,
          };

          if (typeof data.uuid === 'string') {
            node.uuid = data.uuid;
          }
          if (typeof data.name === 'string') {
            node.name = data.name;
          }

          // 位置
          if (data.position && typeof data.position === 'object') {
            const pos = data.position as Record<string, unknown>;
            if (
              typeof pos.x === 'number' &&
              typeof pos.y === 'number' &&
              typeof pos.z === 'number'
            ) {
              node.position = [pos.x, pos.y, pos.z];
            }
          }

          // 回転
          if (data.rotation && typeof data.rotation === 'object') {
            const rot = data.rotation as Record<string, unknown>;
            if (
              typeof rot.x === 'number' &&
              typeof rot.y === 'number' &&
              typeof rot.z === 'number'
            ) {
              node.rotation = [rot.x, rot.y, rot.z];
            }
          }

          // スケール
          if (data.scale && typeof data.scale === 'object') {
            const scl = data.scale as Record<string, unknown>;
            if (
              typeof scl.x === 'number' &&
              typeof scl.y === 'number' &&
              typeof scl.z === 'number'
            ) {
              node.scale = [scl.x, scl.y, scl.z];
            }
          }

          // ジオメトリ
          if (data.geometry && typeof data.geometry === 'object') {
            const geo = data.geometry as Record<string, unknown>;
            node.geometry = typeof geo.type === 'string' ? geo.type : 'BufferGeometry';
          }

          // マテリアル
          if (data.material && typeof data.material === 'object') {
            const mat = data.material as Record<string, unknown>;
            const materialInfo: MaterialInfo = {
              type: typeof mat.type === 'string' ? mat.type : 'Material',
            };

            if (typeof mat.color === 'string') {
              materialInfo.color = `#${mat.color}`;
            }
            if (typeof mat.metalness === 'number') {
              materialInfo.metalness = mat.metalness;
            }
            if (typeof mat.roughness === 'number') {
              materialInfo.roughness = mat.roughness;
            }
            if (typeof mat.opacity === 'number') {
              materialInfo.opacity = mat.opacity;
            }
            if (typeof mat.transparent === 'boolean') {
              materialInfo.transparent = mat.transparent;
            }

            node.material = materialInfo;
          }

          // ライト色
          if (typeof data.lightColor === 'string') {
            node.color = `#${data.lightColor}`;
          }
          if (typeof data.intensity === 'number') {
            node.intensity = data.intensity;
          }

          // InstancedMesh
          if (typeof data.instanceCount === 'number') {
            node.instanceCount = data.instanceCount;
          }

          let count = 1;
          let isTruncated = false;

          // 子オブジェクト
          if (Array.isArray(data.children) && data.children.length > 0) {
            node.children = [];
            for (const child of data.children) {
              const childResult = convertToSceneGraphNode(child, depth + 1);
              if (childResult.node) {
                node.children.push(childResult.node);
                count += childResult.count;
                isTruncated = isTruncated || childResult.truncated;
              }
            }
          }

          if (data.childrenTruncated === true) {
            node.truncated = true;
            isTruncated = true;
          }

          return { node, count, truncated: isTruncated };
        };

        for (const child of sceneData.children) {
          const result = convertToSceneGraphNode(child, 1);
          if (result.node) {
            sceneGraph.push(result.node);
            sceneObjectCount += result.count;
            sceneTruncated = sceneTruncated || result.truncated;
          }
        }

        limitsApplied.childrenLimit =
          limitsApplied.childrenLimit ||
          sceneData.totalChildrenCount > opts.maxChildrenPerScene;
        limitsApplied.depthLimit = limitsApplied.depthLimit || sceneTruncated;
        totalExtractedObjects += sceneObjectCount;

        const extendedScene: ExtendedSceneInfo = {
          id: sceneData.uuid,
          sceneGraph,
          totalObjects: sceneObjectCount,
          wasTruncated: sceneTruncated,
        };

        if (sceneData.name !== undefined) {
          extendedScene.name = sceneData.name;
        }
        if (sceneData.background !== undefined) {
          extendedScene.background = `#${sceneData.background.hex}`;
        }
        if (sceneData.fog !== undefined) {
          extendedScene.fog = {
            type: sceneData.fog.type,
            color: `#${sceneData.fog.color}`,
          };
          if (sceneData.fog.density !== undefined) {
            extendedScene.fog.density = sceneData.fog.density;
          }
          if (sceneData.fog.near !== undefined) {
            extendedScene.fog.near = sceneData.fog.near;
          }
          if (sceneData.fog.far !== undefined) {
            extendedScene.fog.far = sceneData.fog.far;
          }
        }

        extractedScenes.push(extendedScene);
      }

      // JSONサイズ検証
      const jsonStr = JSON.stringify({ scenes: extractedScenes });
      const jsonSizeBytes = new TextEncoder().encode(jsonStr).length;

      if (jsonSizeBytes > opts.maxJsonSize) {
        limitsApplied.sizeLimit = true;
        errors.push(
          `JSON size (${jsonSizeBytes} bytes) exceeds limit (${opts.maxJsonSize} bytes)`
        );
      }

      const processingTimeMs = Date.now() - startTime;

      const result: SceneGraphExtractionResult = {
        scenes: extractedScenes,
        textures: [], // ブラウザコンテキスト外では取得が困難なため空
        meta: {
          processingTimeMs,
          originalSceneCount: rawData.scenesData.length,
          extractedSceneCount: extractedScenes.length,
          originalObjectCount: totalOriginalObjects,
          extractedObjectCount: totalExtractedObjects,
          jsonSizeBytes,
          hitLimits:
            limitsApplied.sceneLimit ||
            limitsApplied.childrenLimit ||
            limitsApplied.depthLimit ||
            limitsApplied.sizeLimit,
          limitsApplied,
        },
      };

      // versionがある場合のみ設定（exactOptionalPropertyTypes対応）
      if (rawData.version !== undefined) {
        result.version = rawData.version;
      }

      if (errors.length > 0) {
        result.errors = errors;
      }

      if (isDevelopment()) {
        logger.debug('[ThreeJSSceneExtractor] Extraction completed', {
          version: result.version,
          scenesCount: result.scenes.length,
          extractedObjects: totalExtractedObjects,
          processingTimeMs,
          hitLimits: result.meta.hitLimits,
        });
      }

      return result;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[ThreeJSSceneExtractor] Extraction failed', { error });
      }

      return {
        scenes: [],
        textures: [],
        meta: {
          processingTimeMs: Date.now() - startTime,
          originalSceneCount: 0,
          extractedSceneCount: 0,
          originalObjectCount: 0,
          extractedObjectCount: 0,
          jsonSizeBytes: 0,
          hitLimits: false,
          limitsApplied: {
            sceneLimit: false,
            childrenLimit: false,
            depthLimit: false,
            sizeLimit: false,
          },
        },
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }
  /* eslint-enable no-undef */
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * ThreeJSSceneExtractor インスタンスを作成
 *
 * 注: このクラスは静的メソッドのみで構成されているため、
 * インスタンス化は必要ありませんが、将来の拡張性のために提供しています。
 */
export function createThreeJSSceneExtractor(): ThreeJSSceneExtractor {
  return new ThreeJSSceneExtractor();
}
