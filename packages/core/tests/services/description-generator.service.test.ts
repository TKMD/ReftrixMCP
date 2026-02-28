// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Description Generator Service Tests
 * TDD: アセットのdescription自動生成サービスのテスト
 *
 * テスト対象:
 * - generateDescription: メイン生成関数
 * - parseIconName: アイコン名の解析
 * - translateToJapanese: 英語キーワードの日本語変換
 * - buildDescriptionParts: description構成要素の構築
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateDescription,
  parseIconName,
  translateToJapanese,
  buildDescriptionParts,
  type AssetMetadata,
  type DescriptionOptions,
} from '../../src/services/description-generator.service';

// 開発環境ログ出力
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: description-generator.service.test.ts');
}

describe('DescriptionGeneratorService', () => {
  describe('parseIconName', () => {
    describe('正常系テスト', () => {
      it('lucideアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'lucide-arrow-big-right';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'lucide',
          keywords: ['arrow', 'big', 'right'],
          variant: undefined,
        });
      });

      it('heroiconsアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'heroicons-bolt';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'heroicons',
          keywords: ['bolt'],
          variant: undefined,
        });
      });

      it('simpleiconsブランドアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'simpleicons-ionic';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'simpleicons',
          keywords: ['ionic'],
          variant: undefined,
        });
      });

      it('iconoirアイコン名（variant付き）を正しく解析する', () => {
        // Arrange
        const name = 'iconoir-regular-maps-turn-right';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'iconoir',
          keywords: ['maps', 'turn', 'right'],
          variant: 'regular',
        });
      });

      it('iconoirアイコン名（solid variant）を正しく解析する', () => {
        // Arrange
        const name = 'iconoir-solid-heart';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'iconoir',
          keywords: ['heart'],
          variant: 'solid',
        });
      });

      it('openpeepsイラスト名を正しく解析する', () => {
        // Arrange
        const name = 'openpeeps-peep-1764844155730-1990';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'openpeeps',
          keywords: ['peep'],
          variant: undefined,
        });
      });

      it('tablerアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'tabler-brand-github';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'tabler',
          keywords: ['brand', 'github'],
          variant: undefined,
        });
      });

      it('bootstrapアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'bootstrap-arrow-up-circle';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'bootstrap',
          keywords: ['arrow', 'up', 'circle'],
          variant: undefined,
        });
      });

      it('phosphorアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'phosphor-house-line';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'phosphor',
          keywords: ['house', 'line'],
          variant: undefined,
        });
      });

      it('featherアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'feather-activity';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'feather',
          keywords: ['activity'],
          variant: undefined,
        });
      });

      it('remixアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'remix-home-line';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'remix',
          keywords: ['home', 'line'],
          variant: undefined,
        });
      });

      it('ioniconsアイコン名を正しく解析する', () => {
        // Arrange
        const name = 'ionicons-rocket-outline';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result).toEqual({
          source: 'ionicons',
          keywords: ['rocket', 'outline'],
          variant: undefined,
        });
      });
    });

    describe('エッジケース', () => {
      it('未知のソースでも解析できる', () => {
        // Arrange
        const name = 'custom-my-icon';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result.source).toBe('custom');
        expect(result.keywords).toEqual(['my', 'icon']);
      });

      it('ハイフンのない名前を処理できる', () => {
        // Arrange
        const name = 'icon';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result.source).toBe('icon');
        expect(result.keywords).toEqual([]);
      });

      it('数字を含む名前を処理できる', () => {
        // Arrange
        const name = 'lucide-arrow-down-0-1';

        // Act
        const result = parseIconName(name);

        // Assert
        expect(result.source).toBe('lucide');
        expect(result.keywords).toContain('arrow');
        expect(result.keywords).toContain('down');
        expect(result.keywords).toContain('0');
        expect(result.keywords).toContain('1');
      });
    });
  });

  describe('translateToJapanese', () => {
    describe('一般的なアイコンキーワード', () => {
      it('arrowを矢印に変換する', () => {
        expect(translateToJapanese('arrow')).toBe('矢印');
      });

      it('homeをホームに変換する', () => {
        expect(translateToJapanese('home')).toBe('ホーム');
      });

      it('heartをハートに変換する', () => {
        expect(translateToJapanese('heart')).toBe('ハート');
      });

      it('starをスターに変換する', () => {
        expect(translateToJapanese('star')).toBe('スター');
      });

      it('userをユーザーに変換する', () => {
        expect(translateToJapanese('user')).toBe('ユーザー');
      });

      it('searchを検索に変換する', () => {
        expect(translateToJapanese('search')).toBe('検索');
      });

      it('settingsを設定に変換する', () => {
        expect(translateToJapanese('settings')).toBe('設定');
      });

      it('notificationを通知に変換する', () => {
        expect(translateToJapanese('notification')).toBe('通知');
      });

      it('mailをメールに変換する', () => {
        expect(translateToJapanese('mail')).toBe('メール');
      });
    });

    describe('方向キーワード', () => {
      it('upを上向きに変換する', () => {
        expect(translateToJapanese('up')).toBe('上向き');
      });

      it('downを下向きに変換する', () => {
        expect(translateToJapanese('down')).toBe('下向き');
      });

      it('leftを左向きに変換する', () => {
        expect(translateToJapanese('left')).toBe('左向き');
      });

      it('rightを右向きに変換する', () => {
        expect(translateToJapanese('right')).toBe('右向き');
      });
    });

    describe('形状キーワード', () => {
      it('circleを円形に変換する', () => {
        expect(translateToJapanese('circle')).toBe('円形');
      });

      it('squareを四角形に変換する', () => {
        expect(translateToJapanese('square')).toBe('四角形');
      });
    });

    describe('未知のキーワード', () => {
      it('辞書にないキーワードはそのまま返す', () => {
        expect(translateToJapanese('xyzabc')).toBe('xyzabc');
      });
    });
  });

  describe('buildDescriptionParts', () => {
    describe('正常系テスト', () => {
      it('アイコンのdescriptionパーツを構築する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-right',
          style: 'line',
          purpose: 'icon',
          tags: ['navigation', 'direction'],
        };

        // Act
        const result = buildDescriptionParts(metadata);

        // Assert
        expect(result.mainDescription).toContain('矢印');
        expect(result.mainDescription).toContain('右向き');
        expect(result.styleInfo).toBe('lineスタイル');
        expect(result.sourceInfo).toContain('Lucide');
        expect(result.usageHint).toBeDefined();
      });

      it('イラストのdescriptionパーツを構築する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'openpeeps-peep-12345',
          style: 'line',
          purpose: 'illustration',
          tags: ['person', 'avatar'],
        };

        // Act
        const result = buildDescriptionParts(metadata);

        // Assert
        expect(result.mainDescription).toContain('人物');
        expect(result.sourceInfo).toContain('OpenPeeps');
        expect(result.styleInfo).toBe('手描き風イラスト');
      });

      it('ブランドアイコンのdescriptionパーツを構築する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'simpleicons-github',
          style: 'filled',
          purpose: 'icon',
          tags: ['brand', 'social'],
        };

        // Act
        const result = buildDescriptionParts(metadata);

        // Assert
        expect(result.mainDescription).toContain('GitHub');
        expect(result.sourceInfo).toContain('Simple Icons');
        expect(result.usageHint).toContain('ブランド');
      });

      it('variant付きアイコンのdescriptionパーツを構築する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'iconoir-solid-heart',
          style: 'filled',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = buildDescriptionParts(metadata);

        // Assert
        expect(result.mainDescription).toContain('ハート');
        expect(result.styleInfo).toContain('solid');
      });
    });
  });

  describe('generateDescription', () => {
    describe('正常系テスト', () => {
      it('lucideアイコンのdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-big-right',
          style: 'line',
          purpose: 'icon',
          tags: ['arrow', 'navigation'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('矢印');
        expect(result).toContain('右向き');
        expect(result).toContain('Lucide');
        expect(result.length).toBeGreaterThan(10);
        expect(result.length).toBeLessThan(300);
      });

      it('heroiconsアイコンのdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'heroicons-bolt',
          style: 'line',
          purpose: 'icon',
          tags: ['power', 'energy'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('稲妻');
        expect(result).toContain('Heroicons');
      });

      it('openpeepsイラストのdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'openpeeps-peep-1764844155730',
          style: 'line',
          purpose: 'illustration',
          tags: ['person', 'avatar'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('人物');
        expect(result).toContain('OpenPeeps');
        expect(result).toContain('イラスト');
      });

      it('simpleiconsブランドアイコンのdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'simpleicons-github',
          style: 'filled',
          purpose: 'icon',
          tags: ['brand'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('GitHub');
        expect(result).toContain('ロゴ');
        expect(result).toContain('Simple Icons');
      });

      it('タグ情報を活用してdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-icon',
          style: 'flat',
          purpose: 'icon',
          tags: ['navigation', 'menu', 'hamburger'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('ナビゲーション');
      });

      it('数字を含む名前でも適切にdescriptionを生成する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-down-0-1',
          style: 'line',
          purpose: 'icon',
          tags: ['sort', 'number'],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('矢印');
        expect(result).toContain('下向き');
        // タグからの情報は「関連:」セクションに含まれるか、または本文に統合される
        expect(result.includes('ソート') || result.includes('関連')).toBe(true);
      });
    });

    describe('スタイル別テスト', () => {
      it('lineスタイルを適切に説明する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-home',
          style: 'line',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('line');
      });

      it('filledスタイルを適切に説明する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-home',
          style: 'filled',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('filled');
      });

      it('gradientスタイルを適切に説明する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-icon',
          style: 'gradient',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('グラデーション');
      });
    });

    describe('purpose別テスト', () => {
      it('iconのdescriptionに用途を含める', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-home',
          style: 'line',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('アイコン');
      });

      it('illustrationのdescriptionに用途を含める', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-illustration',
          style: 'line',
          purpose: 'illustration',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('イラスト');
      });

      it('decorationのdescriptionに用途を含める', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-decoration',
          style: 'flat',
          purpose: 'decoration',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain('装飾');
      });
    });

    describe('オプションテスト', () => {
      it('maxLengthオプションで文字数を制限できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-big-right',
          style: 'line',
          purpose: 'icon',
          tags: ['navigation', 'direction', 'ui', 'interface'],
        };
        const options: DescriptionOptions = {
          maxLength: 50,
        };

        // Act
        const result = generateDescription(metadata, options);

        // Assert
        expect(result.length).toBeLessThanOrEqual(50);
      });

      it('includeSourceInfoオプションでソース情報を除外できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-right',
          style: 'line',
          purpose: 'icon',
          tags: [],
        };
        const options: DescriptionOptions = {
          includeSourceInfo: false,
        };

        // Act
        const result = generateDescription(metadata, options);

        // Assert
        expect(result).not.toContain('Lucide');
      });

      it('includeUsageHintオプションで用途ヒントを除外できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-arrow-right',
          style: 'line',
          purpose: 'icon',
          tags: [],
        };
        const options: DescriptionOptions = {
          includeUsageHint: false,
        };

        // Act
        const result = generateDescription(metadata, options);

        // Assert
        expect(result).not.toContain('使用');
      });
    });

    describe('エッジケース', () => {
      it('空のタグ配列でも生成できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'lucide-home',
          style: 'line',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('styleがundefinedでも生成できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-icon',
          style: undefined,
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('purposeがundefinedでも生成できる', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-icon',
          style: 'line',
          purpose: undefined,
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('非常に長いタグリストでも適切に処理する', () => {
        // Arrange
        const metadata: AssetMetadata = {
          name: 'custom-icon',
          style: 'line',
          purpose: 'icon',
          tags: Array(50).fill('tag'),
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toBeDefined();
        expect(result.length).toBeLessThan(500);
      });
    });
  });

  describe('特定ソースの日本語変換テスト', () => {
    describe('Lucide固有キーワード', () => {
      const lucideKeywords = [
        { name: 'lucide-activity', expected: 'アクティビティ' },
        { name: 'lucide-alert-circle', expected: 'アラート' },
        { name: 'lucide-archive', expected: 'アーカイブ' },
        { name: 'lucide-bell', expected: '通知' },
        { name: 'lucide-bookmark', expected: 'ブックマーク' },
        { name: 'lucide-calendar', expected: 'カレンダー' },
        { name: 'lucide-camera', expected: 'カメラ' },
        { name: 'lucide-check', expected: 'チェック' },
        { name: 'lucide-clipboard', expected: 'クリップボード' },
        { name: 'lucide-clock', expected: '時計' },
        { name: 'lucide-cloud', expected: 'クラウド' },
        { name: 'lucide-code', expected: 'コード' },
        { name: 'lucide-coffee', expected: 'コーヒー' },
        { name: 'lucide-copy', expected: 'コピー' },
        { name: 'lucide-credit-card', expected: 'クレジットカード' },
        { name: 'lucide-database', expected: 'データベース' },
        { name: 'lucide-delete', expected: '削除' },
        { name: 'lucide-download', expected: 'ダウンロード' },
        { name: 'lucide-edit', expected: '編集' },
        { name: 'lucide-eye', expected: '表示' },
        { name: 'lucide-file', expected: 'ファイル' },
        { name: 'lucide-filter', expected: 'フィルター' },
        { name: 'lucide-folder', expected: 'フォルダー' },
        { name: 'lucide-globe', expected: 'グローブ' },
        { name: 'lucide-grid', expected: 'グリッド' },
        { name: 'lucide-help-circle', expected: 'ヘルプ' },
        { name: 'lucide-image', expected: '画像' },
        { name: 'lucide-inbox', expected: '受信トレイ' },
        { name: 'lucide-info', expected: '情報' },
        { name: 'lucide-layers', expected: 'レイヤー' },
        { name: 'lucide-layout', expected: 'レイアウト' },
        { name: 'lucide-link', expected: 'リンク' },
        { name: 'lucide-list', expected: 'リスト' },
        { name: 'lucide-lock', expected: 'ロック' },
        { name: 'lucide-log-in', expected: 'ログイン' },
        { name: 'lucide-log-out', expected: 'ログアウト' },
        { name: 'lucide-map', expected: 'マップ' },
        { name: 'lucide-menu', expected: 'メニュー' },
        { name: 'lucide-message', expected: 'メッセージ' },
        { name: 'lucide-mic', expected: 'マイク' },
        { name: 'lucide-minus', expected: 'マイナス' },
        { name: 'lucide-monitor', expected: 'モニター' },
        { name: 'lucide-moon', expected: '月' },
        { name: 'lucide-more-horizontal', expected: 'その他' },
        { name: 'lucide-music', expected: '音楽' },
        { name: 'lucide-navigation', expected: 'ナビゲーション' },
        { name: 'lucide-package', expected: 'パッケージ' },
        { name: 'lucide-paperclip', expected: '添付' },
        { name: 'lucide-pause', expected: '一時停止' },
        { name: 'lucide-phone', expected: '電話' },
        { name: 'lucide-play', expected: '再生' },
        { name: 'lucide-plus', expected: 'プラス' },
        { name: 'lucide-power', expected: '電源' },
        { name: 'lucide-printer', expected: 'プリンター' },
        { name: 'lucide-refresh', expected: 'リフレッシュ' },
        { name: 'lucide-save', expected: '保存' },
        { name: 'lucide-send', expected: '送信' },
        { name: 'lucide-share', expected: '共有' },
        { name: 'lucide-shield', expected: 'シールド' },
        { name: 'lucide-shopping-cart', expected: 'カート' },
        { name: 'lucide-shuffle', expected: 'シャッフル' },
        { name: 'lucide-sliders', expected: 'スライダー' },
        { name: 'lucide-smartphone', expected: 'スマートフォン' },
        { name: 'lucide-sort', expected: 'ソート' },
        { name: 'lucide-sun', expected: '太陽' },
        { name: 'lucide-table', expected: 'テーブル' },
        { name: 'lucide-tag', expected: 'タグ' },
        { name: 'lucide-terminal', expected: 'ターミナル' },
        { name: 'lucide-thumbs-up', expected: 'いいね' },
        { name: 'lucide-trash', expected: 'ゴミ箱' },
        { name: 'lucide-trending-up', expected: 'トレンド' },
        { name: 'lucide-tv', expected: 'テレビ' },
        { name: 'lucide-type', expected: 'テキスト' },
        { name: 'lucide-umbrella', expected: '傘' },
        { name: 'lucide-unlock', expected: 'ロック解除' },
        { name: 'lucide-upload', expected: 'アップロード' },
        { name: 'lucide-video', expected: 'ビデオ' },
        { name: 'lucide-volume', expected: 'ボリューム' },
        { name: 'lucide-wifi', expected: 'Wi-Fi' },
        { name: 'lucide-x', expected: '閉じる' },
        { name: 'lucide-zap', expected: '稲妻' },
        { name: 'lucide-zoom-in', expected: 'ズームイン' },
        { name: 'lucide-zoom-out', expected: 'ズームアウト' },
      ];

      it.each(lucideKeywords.slice(0, 10))('$name のキーワードを適切に日本語化する', ({ name, expected }) => {
        // Arrange
        const metadata: AssetMetadata = {
          name,
          style: 'line',
          purpose: 'icon',
          tags: [],
        };

        // Act
        const result = generateDescription(metadata);

        // Assert
        expect(result).toContain(expected);
      });
    });
  });

  describe('パフォーマンステスト', () => {
    it('1件のdescription生成が10ms以内で完了する', () => {
      // Arrange
      const metadata: AssetMetadata = {
        name: 'lucide-arrow-big-right',
        style: 'line',
        purpose: 'icon',
        tags: ['arrow', 'navigation', 'direction', 'ui'],
      };

      // Act
      const start = performance.now();
      generateDescription(metadata);
      const duration = performance.now() - start;

      // Assert
      expect(duration).toBeLessThan(10);
    });

    it('100件のdescription生成が100ms以内で完了する', () => {
      // Arrange
      const metadataList: AssetMetadata[] = Array(100).fill(null).map((_, i) => ({
        name: `lucide-icon-${i}`,
        style: 'line' as const,
        purpose: 'icon' as const,
        tags: ['test'],
      }));

      // Act
      const start = performance.now();
      metadataList.forEach(m => generateDescription(m));
      const duration = performance.now() - start;

      // Assert
      expect(duration).toBeLessThan(100);
    });
  });
});
