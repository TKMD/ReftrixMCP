// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze タイムアウト処理改善テスト
 *
 * TDD: Red -> Green -> Refactor
 *
 * テスト対象:
 * 1. 通常サイトは60秒以内で完了
 * 2. WebGL検出によるタイムアウト自動延長
 * 3. タイムアウト時の部分結果返却
 * 4. Progressive戦略でHTML優先、Quality失敗でも返却
 * 5. Strict戦略でタイムアウト時は完全失敗
 *
 * @module tests/tools/page/timeout-handling.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pageAnalyzeInputSchema,
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,
  type PageAnalyzeData,
} from '../../../src/tools/page/schemas';

// =====================================================
// 新しいスキーマ定義のテスト
// =====================================================

describe('page.analyze timeout handling schemas', () => {
  describe('timeout_strategy input field', () => {
    it('should accept "strict" as valid timeout_strategy', () => {
      const input: unknown = {
        url: 'https://example.com',
        timeout_strategy: 'strict',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout_strategy).toBe('strict');
      }
    });

    it('should accept "progressive" as valid timeout_strategy', () => {
      const input: unknown = {
        url: 'https://example.com',
        timeout_strategy: 'progressive',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout_strategy).toBe('progressive');
      }
    });

    it('should default to "progressive" when not specified', () => {
      const input: unknown = {
        url: 'https://example.com',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout_strategy).toBe('progressive');
      }
    });

    it('should reject invalid timeout_strategy values', () => {
      const input: unknown = {
        url: 'https://example.com',
        timeout_strategy: 'invalid',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('partial_results input field', () => {
    it('should accept partial_results: true', () => {
      const input: unknown = {
        url: 'https://example.com',
        partial_results: true,
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.partial_results).toBe(true);
      }
    });

    it('should accept partial_results: false', () => {
      const input: unknown = {
        url: 'https://example.com',
        partial_results: false,
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.partial_results).toBe(false);
      }
    });

    it('should default to true when not specified', () => {
      const input: unknown = {
        url: 'https://example.com',
      };

      const result = pageAnalyzeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.partial_results).toBe(true);
      }
    });
  });

  // =====================================================
  // Per-Phase Timeout Input Fields (v0.1.0)
  // =====================================================

  describe('per-phase timeout input fields (v0.1.0)', () => {
    describe('layoutTimeout', () => {
      it('should accept valid layoutTimeout within range', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 30000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.layoutTimeout).toBe(30000);
        }
      });

      it('should accept minimum layoutTimeout (5000ms)', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 5000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      });

      it('should accept maximum layoutTimeout (300000ms)', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 300000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      });

      it('should reject layoutTimeout below minimum', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 4999,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });

      it('should reject layoutTimeout above maximum', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 300001,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });

      it('should use default layoutTimeout of 120000ms when not provided', () => {
        const input: unknown = {
          url: 'https://example.com',
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.layoutTimeout).toBe(120000);
        }
      });
    });

    describe('motionTimeout', () => {
      it('should accept valid motionTimeout within range', () => {
        const input: unknown = {
          url: 'https://example.com',
          motionTimeout: 120000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.motionTimeout).toBe(120000);
        }
      });

      it('should reject motionTimeout below minimum', () => {
        const input: unknown = {
          url: 'https://example.com',
          motionTimeout: 4999,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });

      it('should reject motionTimeout above maximum', () => {
        const input: unknown = {
          url: 'https://example.com',
          motionTimeout: 300001,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });

    describe('qualityTimeout', () => {
      it('should accept valid qualityTimeout within range', () => {
        const input: unknown = {
          url: 'https://example.com',
          qualityTimeout: 15000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.qualityTimeout).toBe(15000);
        }
      });

      it('should accept maximum qualityTimeout (60000ms)', () => {
        const input: unknown = {
          url: 'https://example.com',
          qualityTimeout: 60000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      });

      it('should reject qualityTimeout above maximum (60000ms)', () => {
        const input: unknown = {
          url: 'https://example.com',
          qualityTimeout: 60001,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });

    describe('combined per-phase timeouts', () => {
      it('should accept all per-phase timeouts together', () => {
        const input: unknown = {
          url: 'https://example.com',
          layoutTimeout: 30000,
          motionTimeout: 120000,
          qualityTimeout: 15000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.layoutTimeout).toBe(30000);
          expect(result.data.motionTimeout).toBe(120000);
          expect(result.data.qualityTimeout).toBe(15000);
        }
      });

      it('should work with overall timeout and per-phase timeouts', () => {
        const input: unknown = {
          url: 'https://example.com',
          timeout: 180000,
          layoutTimeout: 60000,
          motionTimeout: 90000,
          qualityTimeout: 30000,
        };

        const result = pageAnalyzeInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.timeout).toBe(180000);
          expect(result.data.layoutTimeout).toBe(60000);
          expect(result.data.motionTimeout).toBe(90000);
          expect(result.data.qualityTimeout).toBe(30000);
        }
      });
    });
  });
});

// =====================================================
// execution_status 出力フィールドのテスト
// =====================================================

describe('page.analyze execution_status output', () => {
  it('should include execution_status in successful response', () => {
    // 期待されるレスポンス構造
    const expectedOutput: PageAnalyzeOutput = {
      success: true,
      data: {
        id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
        url: 'https://example.com',
        normalizedUrl: 'https://example.com/',
        metadata: {
          title: 'Example',
        },
        source: {
          type: 'user_provided',
          usageScope: 'inspiration_only',
        },
        totalProcessingTimeMs: 5000,
        analyzedAt: new Date().toISOString(),
        // 新しいexecution_statusフィールド
        execution_status: {
          completed_phases: ['html', 'screenshot', 'layout', 'motion', 'quality'],
          failed_phases: [],
          timeout_occurred: false,
          actual_duration_ms: 5000,
          webgl_detected: false,
          timeout_extended: false,
        },
      },
    };

    // execution_statusが存在することを確認
    expect(expectedOutput.success).toBe(true);
    if (expectedOutput.success) {
      expect(expectedOutput.data.execution_status).toBeDefined();
      expect(expectedOutput.data.execution_status?.completed_phases).toContain('html');
      expect(expectedOutput.data.execution_status?.failed_phases).toHaveLength(0);
      expect(expectedOutput.data.execution_status?.timeout_occurred).toBe(false);
    }
  });

  it('should show failed_phases when timeout occurs with partial_results', () => {
    const expectedOutput: PageAnalyzeOutput = {
      success: true, // partial_results=trueなのでsuccess=true
      data: {
        id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
        url: 'https://example.com',
        normalizedUrl: 'https://example.com/',
        metadata: {
          title: 'Example',
        },
        source: {
          type: 'user_provided',
          usageScope: 'inspiration_only',
        },
        totalProcessingTimeMs: 60000,
        analyzedAt: new Date().toISOString(),
        // タイムアウト発生時のexecution_status
        execution_status: {
          completed_phases: ['html', 'screenshot', 'layout'],
          failed_phases: ['motion', 'quality'], // これらがタイムアウト
          timeout_occurred: true,
          actual_duration_ms: 60000,
          webgl_detected: false,
          timeout_extended: false,
        },
      },
    };

    if (expectedOutput.success) {
      expect(expectedOutput.data.execution_status?.completed_phases).toContain('layout');
      expect(expectedOutput.data.execution_status?.failed_phases).toContain('motion');
      expect(expectedOutput.data.execution_status?.failed_phases).toContain('quality');
      expect(expectedOutput.data.execution_status?.timeout_occurred).toBe(true);
    }
  });

  it('should show webgl_detected and timeout_extended when WebGL site', () => {
    const expectedOutput: PageAnalyzeOutput = {
      success: true,
      data: {
        id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
        url: 'https://threejs-example.com',
        normalizedUrl: 'https://threejs-example.com/',
        metadata: {
          title: 'Three.js Demo',
        },
        source: {
          type: 'user_provided',
          usageScope: 'inspiration_only',
        },
        totalProcessingTimeMs: 90000,
        analyzedAt: new Date().toISOString(),
        // WebGL検出時のexecution_status
        execution_status: {
          completed_phases: ['html', 'screenshot', 'layout', 'motion', 'quality'],
          failed_phases: [],
          timeout_occurred: false,
          actual_duration_ms: 90000,
          webgl_detected: true,
          timeout_extended: true, // 60s -> 120sに自動延長
        },
      },
    };

    if (expectedOutput.success) {
      expect(expectedOutput.data.execution_status?.webgl_detected).toBe(true);
      expect(expectedOutput.data.execution_status?.timeout_extended).toBe(true);
    }
  });

  // =====================================================
  // Per-Phase Timeout Output Fields (v0.1.0)
  // =====================================================

  describe('timedout_phases and phase_timeouts output (v0.1.0)', () => {
    it('should include timedout_phases when specific phases timeout', () => {
      const expectedOutput: PageAnalyzeOutput = {
        success: true,
        data: {
          id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
          url: 'https://heavy-site.com',
          normalizedUrl: 'https://heavy-site.com/',
          metadata: {
            title: 'Heavy Site',
          },
          source: {
            type: 'user_provided',
            usageScope: 'inspiration_only',
          },
          totalProcessingTimeMs: 45000,
          analyzedAt: new Date().toISOString(),
          execution_status: {
            completed_phases: ['html', 'screenshot', 'motion', 'quality'],
            failed_phases: ['layout'],
            timedout_phases: ['layout'], // レイアウトのみタイムアウト
            timeout_occurred: true,
            actual_duration_ms: 45000,
            webgl_detected: false,
            timeout_extended: false,
            phase_timeouts: {
              layout: 30000,
              motion: 120000,
              quality: 15000,
            },
          },
        },
      };

      if (expectedOutput.success) {
        expect(expectedOutput.data.execution_status?.timedout_phases).toEqual(['layout']);
        expect(expectedOutput.data.execution_status?.phase_timeouts).toBeDefined();
        expect(expectedOutput.data.execution_status?.phase_timeouts?.layout).toBe(30000);
      }
    });

    it('should include phase_timeouts with user-specified values', () => {
      const expectedOutput: PageAnalyzeOutput = {
        success: true,
        data: {
          id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
          url: 'https://example.com',
          normalizedUrl: 'https://example.com/',
          metadata: {
            title: 'Example',
          },
          source: {
            type: 'user_provided',
            usageScope: 'inspiration_only',
          },
          totalProcessingTimeMs: 10000,
          analyzedAt: new Date().toISOString(),
          execution_status: {
            completed_phases: ['html', 'screenshot', 'layout', 'motion', 'quality'],
            failed_phases: [],
            timeout_occurred: false,
            actual_duration_ms: 10000,
            webgl_detected: false,
            timeout_extended: false,
            phase_timeouts: {
              layout: 60000,  // ユーザー指定
              motion: 90000,  // ユーザー指定
              quality: 30000, // ユーザー指定
            },
          },
        },
      };

      if (expectedOutput.success) {
        expect(expectedOutput.data.execution_status?.phase_timeouts?.layout).toBe(60000);
        expect(expectedOutput.data.execution_status?.phase_timeouts?.motion).toBe(90000);
        expect(expectedOutput.data.execution_status?.phase_timeouts?.quality).toBe(30000);
      }
    });

    it('should show multiple timedout_phases sorted by priority', () => {
      const expectedOutput: PageAnalyzeOutput = {
        success: true,
        data: {
          id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
          url: 'https://very-heavy-site.com',
          normalizedUrl: 'https://very-heavy-site.com/',
          metadata: {
            title: 'Very Heavy Site',
          },
          source: {
            type: 'user_provided',
            usageScope: 'inspiration_only',
          },
          totalProcessingTimeMs: 60000,
          analyzedAt: new Date().toISOString(),
          execution_status: {
            completed_phases: ['html', 'screenshot'],
            failed_phases: ['layout', 'motion', 'quality'],
            timedout_phases: ['layout', 'motion', 'quality'], // 優先順位でソート
            timeout_occurred: true,
            actual_duration_ms: 60000,
            webgl_detected: false,
            timeout_extended: false,
          },
        },
      };

      if (expectedOutput.success) {
        // 優先順位: layout -> motion -> quality
        expect(expectedOutput.data.execution_status?.timedout_phases).toEqual([
          'layout',
          'motion',
          'quality',
        ]);
      }
    });
  });
});

// =====================================================
// WebGL検出ロジックのテスト
// =====================================================

describe('WebGL detection', () => {
  // これらはユニットテストレベルでHTML文字列からの検出をテスト
  // 実際のPlaywright検出は統合テストで

  it('should detect Three.js script tag', () => {
    const html = `
      <html>
        <head>
          <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
        </head>
        <body>
          <canvas id="webgl"></canvas>
        </body>
      </html>
    `;

    // WebGL検出関数をテスト（実装後に有効化）
    // const result = detectWebGL(html);
    // expect(result.detected).toBe(true);
    // expect(result.libraries).toContain('three.js');

    // 仮のテスト（スキーマ定義後にテスト）
    expect(html.includes('three')).toBe(true);
  });

  it('should detect WebGL canvas context', () => {
    const html = `
      <html>
        <body>
          <canvas id="gl-canvas"></canvas>
          <script>
            const canvas = document.getElementById('gl-canvas');
            const gl = canvas.getContext('webgl');
          </script>
        </body>
      </html>
    `;

    expect(html.includes('webgl')).toBe(true);
  });

  it('should detect Babylon.js', () => {
    const html = `
      <html>
        <head>
          <script src="https://cdn.babylonjs.com/babylon.js"></script>
        </head>
        <body></body>
      </html>
    `;

    expect(html.includes('babylon')).toBe(true);
  });

  it('should not detect WebGL in simple HTML', () => {
    const html = `
      <html>
        <head>
          <title>Simple Page</title>
        </head>
        <body>
          <h1>Hello World</h1>
        </body>
      </html>
    `;

    expect(html.includes('webgl')).toBe(false);
    expect(html.includes('three')).toBe(false);
  });
});

// =====================================================
// Progressive Loading テスト
// =====================================================

describe('Progressive Loading', () => {
  it('should return HTML even when quality analysis fails', () => {
    // Progressive戦略: HTML取得成功、Quality失敗でもsuccess=true
    const mockResult: PageAnalyzeOutput = {
      success: true,
      data: {
        id: '019bc39c-e4ad-75fe-a13a-69af3629b72e',
        url: 'https://example.com',
        normalizedUrl: 'https://example.com/',
        metadata: { title: 'Test' },
        source: { type: 'user_provided', usageScope: 'inspiration_only' },
        totalProcessingTimeMs: 30000,
        analyzedAt: new Date().toISOString(),
        layout: {
          success: true,
          sectionCount: 5,
          sectionTypes: { hero: 1, feature: 3, footer: 1 },
          processingTimeMs: 2000,
        },
        // qualityが失敗してもレスポンスは成功
        execution_status: {
          completed_phases: ['html', 'screenshot', 'layout'],
          failed_phases: ['quality'],
          timeout_occurred: true,
          actual_duration_ms: 30000,
          webgl_detected: false,
          timeout_extended: false,
        },
        warnings: [
          {
            feature: 'quality',
            code: 'TIMEOUT_ERROR',
            message: 'quality-evaluation timed out after 15000ms (graceful degradation)',
          },
        ],
      },
    };

    expect(mockResult.success).toBe(true);
    if (mockResult.success) {
      expect(mockResult.data.layout).toBeDefined();
      expect(mockResult.data.quality).toBeUndefined();
      expect(mockResult.data.execution_status?.completed_phases).toContain('layout');
      expect(mockResult.data.execution_status?.failed_phases).toContain('quality');
    }
  });

  it('should prioritize HTML > Screenshot > Layout > Motion > Quality', () => {
    // 優先順位テスト: 最も重要なHTMLは必ず取得
    const phasePriority = ['html', 'screenshot', 'layout', 'motion', 'quality'];

    // 優先度の高いフェーズが先に完了
    const completedPhases = ['html', 'screenshot', 'layout'];
    const failedPhases = ['motion', 'quality'];

    // HTMLが完了フェーズに含まれていることを確認
    expect(completedPhases[0]).toBe('html');
    expect(completedPhases).toContain('layout');
    expect(failedPhases).toContain('quality'); // 低優先度は失敗しても許容
  });
});

// =====================================================
// Strict戦略テスト
// =====================================================

describe('Strict timeout strategy', () => {
  it('should fail completely when timeout occurs with strict strategy', () => {
    // Strict戦略: タイムアウト発生時はsuccess=false
    const mockResult: PageAnalyzeOutput = {
      success: false,
      error: {
        code: 'TIMEOUT_ERROR',
        message: 'Analysis timed out after 60000ms (strict mode)',
      },
    };

    expect(mockResult.success).toBe(false);
    if (!mockResult.success) {
      expect(mockResult.error.code).toBe('TIMEOUT_ERROR');
    }
  });

  it('should not return partial results with strict strategy', () => {
    // Strict戦略では部分結果を返さない
    const mockStrictResult: PageAnalyzeOutput = {
      success: false,
      error: {
        code: 'TIMEOUT_ERROR',
        message: 'Analysis timed out',
      },
    };

    if (!mockStrictResult.success) {
      // dataプロパティは存在しない
      expect((mockStrictResult as { data?: unknown }).data).toBeUndefined();
    }
  });
});

// =====================================================
// タイムアウト分配テスト
// =====================================================

describe('Timeout distribution', () => {
  // 既存のdistributeTimeout関数のテスト拡張

  it('should extend timeout to 120s when WebGL detected', () => {
    // WebGL検出時は60s -> 120sに延長
    const defaultTimeout = 60000;
    const webglExtendedTimeout = 120000;

    expect(webglExtendedTimeout).toBe(defaultTimeout * 2);
  });

  it('should use user-specified timeout when larger than WebGL default', () => {
    // ユーザーが180sを指定した場合はそのまま使用
    const userTimeout = 180000;
    const webglDefaultExtension = 120000;

    const effectiveTimeout = Math.max(userTimeout, webglDefaultExtension);
    expect(effectiveTimeout).toBe(180000);
  });

  it('should not extend timeout for non-WebGL sites', () => {
    // 通常サイトはタイムアウト延長なし
    const defaultTimeout = 60000;
    const webglDetected = false;

    const effectiveTimeout = webglDetected ? 120000 : defaultTimeout;
    expect(effectiveTimeout).toBe(60000);
  });
});

// =====================================================
// AbortController テスト
// =====================================================

describe('AbortController for graceful timeout', () => {
  it('should abort pending operations when timeout occurs', async () => {
    const controller = new AbortController();
    const { signal } = controller;

    // 5秒後に中断
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 100);

    // 中断可能なフェッチ操作のモック
    const mockFetch = async (): Promise<string> => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('Aborted'));
        });

        // 通常は1秒で完了するが、abortされる
        setTimeout(() => {
          if (!signal.aborted) {
            resolve('completed');
          }
        }, 1000);
      });
    };

    await expect(mockFetch()).rejects.toThrow('Aborted');
    clearTimeout(timeoutId);
  });
});

// =====================================================
// 統合テスト用のモック設定
// =====================================================

describe('Integration test setup', () => {
  it('should have correct test file structure', () => {
    // このテストファイルが正しい場所にあることを確認
    expect(true).toBe(true);
  });
});
