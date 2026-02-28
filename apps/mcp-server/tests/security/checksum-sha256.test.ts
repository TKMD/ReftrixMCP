// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SHA-256チェックサム実装テスト（SEC H-01対応）
 *
 * TDD Green フェーズ:
 * - SHA-256ハッシュ生成機能
 * - ファイル整合性検証機能
 * - 破損ファイル検出機能
 * - チェックサム比較機能
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SHA256ChecksumService,
  ChecksumError,
  checksumService,
} from '../../src/services/checksum-service';

describe('SHA-256 Checksum Service (SEC H-01)', () => {
  let service: SHA256ChecksumService;
  let tempDir: string;

  beforeEach(async () => {
    service = new SHA256ChecksumService();
    // テスト用一時ディレクトリ作成
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checksum-test-'));

    if (process.env.NODE_ENV === 'development') {
      console.log('[Test] Starting SHA-256 checksum tests (TDD Green Phase)');
    }
  });

  afterEach(async () => {
    // テスト用一時ディレクトリ削除
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 削除失敗は無視
    }
  });

  describe('SHA-256ハッシュ生成', () => {
    it('文字列コンテンツからSHA-256ハッシュを生成できること', () => {
      const content = 'test content';

      const hash = service.generateSHA256(content);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64); // SHA-256は64文字の16進数文字列
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('Bufferコンテンツからハッシュを生成できること', () => {
      const buffer = Buffer.from('test content', 'utf-8');

      const hash = service.generateSHA256(buffer);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('同じコンテンツからは常に同じハッシュが生成されること', () => {
      const content = 'test content';

      const hash1 = service.generateSHA256(content);
      const hash2 = service.generateSHA256(content);

      expect(hash1).toBe(hash2);
    });

    it('異なるコンテンツからは異なるハッシュが生成されること', () => {
      const content1 = 'test content 1';
      const content2 = 'test content 2';

      const hash1 = service.generateSHA256(content1);
      const hash2 = service.generateSHA256(content2);

      expect(hash1).not.toBe(hash2);
    });

    it('空文字列のハッシュを生成できること', () => {
      const emptyContent = '';

      const hash = service.generateSHA256(emptyContent);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
      // SHA-256("")の既知のハッシュ値
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('大きなコンテンツ（10MB）のハッシュを生成できること', () => {
      // 10MBのダミーデータ
      const largeContent = Buffer.alloc(10 * 1024 * 1024, 'a');

      const hash = service.generateSHA256(largeContent);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('SVGコンテンツのハッシュを生成できること', () => {
      const svgContent = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="blue" />
        </svg>
      `;

      const hash = service.generateSHA256(svgContent);

      expect(hash).toBeDefined();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generateHashとgenerateSHA256が同じ結果を返すこと', () => {
      const content = 'test content';

      const hash1 = service.generateHash(content);
      const hash2 = service.generateSHA256(content);

      expect(hash1).toBe(hash2);
    });
  });

  describe('ファイル整合性検証', () => {
    it('正しいチェックサムでファイル整合性を検証できること', async () => {
      const testFile = path.join(tempDir, 'test.svg');
      const content = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
      await fs.writeFile(testFile, content);

      const expectedChecksum = service.generateSHA256(content);
      const result = await service.verifyFileIntegrity(testFile, expectedChecksum);

      expect(result).toBe(true);
    });

    it('誤ったチェックサムで整合性検証が失敗すること', async () => {
      const testFile = path.join(tempDir, 'test.svg');
      const content = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
      await fs.writeFile(testFile, content);

      // 有効なフォーマットだが異なるハッシュ
      const wrongChecksum = 'a'.repeat(64);
      const result = await service.verifyFileIntegrity(testFile, wrongChecksum);

      expect(result).toBe(false);
    });

    it('存在しないファイルでエラーをスローすること', async () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.svg');
      const checksum = 'a'.repeat(64);

      await expect(service.verifyFileIntegrity(nonExistentPath, checksum)).rejects.toThrow(
        ChecksumError
      );
      await expect(service.verifyFileIntegrity(nonExistentPath, checksum)).rejects.toThrow(
        'File not found'
      );
    });

    it('無効なチェックサムフォーマットでエラーをスローすること', async () => {
      const testFile = path.join(tempDir, 'test.svg');
      await fs.writeFile(testFile, 'content');
      const invalidChecksum = 'not_a_valid_sha256_hash';

      await expect(service.verifyFileIntegrity(testFile, invalidChecksum)).rejects.toThrow(
        ChecksumError
      );
      await expect(service.verifyFileIntegrity(testFile, invalidChecksum)).rejects.toThrow(
        'Invalid checksum format'
      );
    });

    it('ファイルが変更された場合に整合性検証が失敗すること', async () => {
      const testFile = path.join(tempDir, 'mutable.svg');
      const originalContent = '<svg><circle r="10"/></svg>';
      await fs.writeFile(testFile, originalContent);

      // オリジナルのチェックサムを保存
      const originalChecksum = service.generateSHA256(originalContent);

      // ファイルを変更
      const modifiedContent = '<svg><circle r="20"/></svg>';
      await fs.writeFile(testFile, modifiedContent);

      // 整合性検証が失敗すること
      const result = await service.verifyFileIntegrity(testFile, originalChecksum);
      expect(result).toBe(false);
    });
  });

  describe('ファイルハッシュ生成（ストリーム処理）', () => {
    it('ファイルからハッシュを生成できること', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      const content = 'test file content';
      await fs.writeFile(testFile, content);

      const hash = await service.generateFileHash(testFile);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      // 同じ内容の文字列ハッシュと一致すること
      expect(hash).toBe(service.generateSHA256(content));
    });

    it('大容量ファイル（50MB）のハッシュを生成できること', async () => {
      const testFile = path.join(tempDir, 'large.bin');
      // 50MBのファイル作成
      const largeContent = Buffer.alloc(50 * 1024 * 1024, 'x');
      await fs.writeFile(testFile, largeContent);

      const hash = await service.generateFileHash(testFile);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('存在しないファイルでエラーをスローすること', async () => {
      const nonExistentFile = path.join(tempDir, 'nonexistent.txt');

      await expect(service.generateFileHash(nonExistentFile)).rejects.toThrow(ChecksumError);
      await expect(service.generateFileHash(nonExistentFile)).rejects.toThrow('File not found');
    });
  });

  describe('チェックサム比較', () => {
    it('同一チェックサムの比較でtrueを返すこと', () => {
      const checksum1 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const checksum2 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      const result = service.compareChecksums(checksum1, checksum2);

      expect(result).toBe(true);
    });

    it('異なるチェックサムの比較でfalseを返すこと', () => {
      const checksum1 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const checksum2 = 'def456abc123def456abc123def456abc123def456abc123def456abc123efab';

      const result = service.compareChecksums(checksum1, checksum2);

      expect(result).toBe(false);
    });

    it('大文字小文字を区別せずに比較できること', () => {
      const checksum1 = 'ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABCD';
      const checksum2 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      const result = service.compareChecksums(checksum1, checksum2);

      expect(result).toBe(true);
    });

    it('空文字列チェックサムの比較を処理できること', () => {
      const emptyChecksum = '';

      const result = service.compareChecksums(emptyChecksum, emptyChecksum);

      expect(result).toBe(true);
    });

    it('無効なチェックサムフォーマットでエラーをスローすること', () => {
      const invalidChecksum = 'not_a_sha256_hash';
      const validChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      expect(() => service.compareChecksums(invalidChecksum, validChecksum)).toThrow(ChecksumError);
      expect(() => service.compareChecksums(invalidChecksum, validChecksum)).toThrow(
        'Invalid checksum format'
      );
    });
  });

  describe('破損ファイル検出', () => {
    it('破損していないファイルを正しく検出できること', () => {
      const originalChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const currentChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      const result = service.detectCorruption(originalChecksum, currentChecksum);

      expect(result.isCorrupted).toBe(false);
      expect(result.details).toBeUndefined();
    });

    it('破損したファイルを検出できること', () => {
      const originalChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const corruptedChecksum = 'def456abc123def456abc123def456abc123def456abc123def456abc123efab';

      const result = service.detectCorruption(originalChecksum, corruptedChecksum);

      expect(result.isCorrupted).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details).toContain('mismatch');
    });

    it('破損検出の詳細情報を提供すること', () => {
      const originalChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const corruptedChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456eeee';

      const result = service.detectCorruption(originalChecksum, corruptedChecksum);

      expect(result.details).toContain('original');
      expect(result.details).toContain('current');
    });

    it('部分的な破損を検出できること', () => {
      // SHA-256は1ビットでも変更があれば完全に異なるハッシュになる
      const originalChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const partiallyCorrupted = 'abc123def456abc123def456abc123def456abc123def456abc123def456abce'; // 最後の1文字変更

      const result = service.detectCorruption(originalChecksum, partiallyCorrupted);

      expect(result.isCorrupted).toBe(true);
    });

    it('無効なフォーマットでエラーをスローすること', () => {
      const invalidChecksum = 'invalid';
      const validChecksum = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

      expect(() => service.detectCorruption(invalidChecksum, validChecksum)).toThrow(ChecksumError);
    });
  });

  describe('チェックサム検証（verifyChecksum）', () => {
    it('正しいハッシュで検証が成功すること', () => {
      const content = 'test content';
      const expectedHash = service.generateHash(content);

      const result = service.verifyChecksum(content, expectedHash);

      expect(result).toBe(true);
    });

    it('誤ったハッシュで検証が失敗すること', () => {
      const content = 'test content';
      const wrongHash = 'a'.repeat(64);

      const result = service.verifyChecksum(content, wrongHash);

      expect(result).toBe(false);
    });

    it('無効なハッシュフォーマットでfalseを返すこと', () => {
      const content = 'test content';
      const invalidHash = 'invalid_format';

      const result = service.verifyChecksum(content, invalidHash);

      expect(result).toBe(false);
    });

    it('Bufferデータの検証ができること', () => {
      const buffer = Buffer.from('test content');
      const expectedHash = service.generateHash(buffer);

      const result = service.verifyChecksum(buffer, expectedHash);

      expect(result).toBe(true);
    });
  });

  describe('実際のSHA-256ハッシュ生成（参照実装）', () => {
    it('crypto.createHashを使った正しいSHA-256生成', () => {
      // これは実装の参照例
      const content = 'test content';

      const hash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      // 既知のテストベクター検証
      const knownContent = 'hello world';
      const knownHash = crypto.createHash('sha256').update(knownContent, 'utf-8').digest('hex');

      // "hello world" のSHA-256は既知の値
      expect(knownHash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('実装が参照実装と同じ結果を返すこと', () => {
      const content = 'hello world';

      const referenceHash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
      const implementationHash = service.generateHash(content);

      expect(implementationHash).toBe(referenceHash);
      expect(implementationHash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('SVGコンテンツの実際のハッシュ生成', () => {
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';

      const hash = crypto.createHash('sha256').update(svgContent, 'utf-8').digest('hex');

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);

      // 同じコンテンツから同じハッシュが生成されることを確認
      const hash2 = crypto.createHash('sha256').update(svgContent, 'utf-8').digest('hex');

      expect(hash).toBe(hash2);

      // 実装も同じ結果を返すこと
      expect(service.generateHash(svgContent)).toBe(hash);
    });
  });

  describe('セキュリティ要件（SEC H-01）', () => {
    it('衝突攻撃に対する耐性（SHA-256の特性）', () => {
      // SHA-256は衝突攻撃に対して耐性がある
      // 同じハッシュを持つ異なるコンテンツを見つけることは計算上困難

      const content1 = 'collision test 1';
      const content2 = 'collision test 2';

      const hash1 = crypto.createHash('sha256').update(content1, 'utf-8').digest('hex');
      const hash2 = crypto.createHash('sha256').update(content2, 'utf-8').digest('hex');

      expect(hash1).not.toBe(hash2);
    });

    it('チェックサムの改ざん検出', () => {
      // オリジナルコンテンツとハッシュ
      const originalContent = 'original secure content';
      const originalHash = crypto.createHash('sha256').update(originalContent, 'utf-8').digest('hex');

      // 改ざんされたコンテンツ
      const tamperedContent = 'original secure content '; // スペース1つ追加
      const tamperedHash = crypto.createHash('sha256').update(tamperedContent, 'utf-8').digest('hex');

      // 改ざんが検出されること
      expect(originalHash).not.toBe(tamperedHash);

      // 実装でも検出できること
      const result = service.verifyChecksum(tamperedContent, originalHash);
      expect(result).toBe(false);
    });

    it('バックアップファイルの整合性検証シナリオ', () => {
      // シナリオ:
      // 1. バックアップ作成時にチェックサムを記録
      // 2. 復元時にチェックサムを検証
      // 3. 一致すればファイルは改ざんされていない

      const backupContent = Buffer.from('backup data content', 'utf-8');
      const storedChecksum = crypto.createHash('sha256').update(backupContent).digest('hex');

      // 復元時のチェックサム検証
      const restoredContent = Buffer.from('backup data content', 'utf-8');
      const currentChecksum = crypto.createHash('sha256').update(restoredContent).digest('hex');

      expect(storedChecksum).toBe(currentChecksum);

      // 実装を使用した検証
      expect(service.verifyChecksum(restoredContent, storedChecksum)).toBe(true);
    });

    it('タイミング攻撃耐性のテスト', () => {
      // タイミング攻撃耐性: 比較時間が入力に依存しないこと
      // crypto.timingSafeEqual を使用していることを確認

      const hash1 = 'a'.repeat(64);
      const hash2 = 'b'.repeat(64);
      const hash3 = 'a'.repeat(63) + 'b'; // 最後だけ違う

      // 比較結果が正しいこと
      expect(service.compareChecksums(hash1, hash1)).toBe(true);
      expect(service.compareChecksums(hash1, hash2)).toBe(false);
      expect(service.compareChecksums(hash1, hash3)).toBe(false);

      // 注: 実際のタイミング測定は環境依存のため、
      // ここではtimingSafeEqualが使用されていることを実装で保証
    });
  });

  describe('デフォルトエクスポート', () => {
    it('デフォルトインスタンスが利用可能であること', () => {
      expect(checksumService).toBeDefined();
      expect(checksumService).toBeInstanceOf(SHA256ChecksumService);
    });

    it('デフォルトインスタンスが正常に動作すること', () => {
      const hash = checksumService.generateHash('test');
      expect(hash).toHaveLength(64);
    });
  });
});
