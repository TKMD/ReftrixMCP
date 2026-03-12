// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Download Script - Unit Tests [H-2]
 *
 * Tests:
 * - URL validation (huggingface.co only)
 * - Path traversal defense
 * - File size cap enforcement
 * - SHA-256 hash computation
 */

import { createHash } from 'crypto';
import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeFileHash,
  validateDownloadUrl,
  validateFileSize,
  validateModelPath,
} from '../../scripts/download-dinov2.js';

// ---------------------------------------------------------------------------
// URL Validation
// ---------------------------------------------------------------------------

describe('validateDownloadUrl', () => {
  it('should accept huggingface.co HTTPS URLs', () => {
    const url = validateDownloadUrl(
      'https://huggingface.co/Xenova/dinov2-base/resolve/main/onnx/model.onnx',
    );
    expect(url.hostname).toBe('huggingface.co');
    expect(url.protocol).toBe('https:');
  });

  it('should reject non-HTTPS URLs', () => {
    expect(() =>
      validateDownloadUrl(
        'http://huggingface.co/Xenova/dinov2-base/resolve/main/onnx/model.onnx',
      ),
    ).toThrow('Download URL must use HTTPS');
  });

  it('should reject non-allowlisted hosts', () => {
    expect(() =>
      validateDownloadUrl('https://evil.com/model.onnx'),
    ).toThrow('Download host not in allowlist');
  });

  it('should reject github.com', () => {
    expect(() =>
      validateDownloadUrl(
        'https://github.com/facebookresearch/dinov2/raw/main/model.onnx',
      ),
    ).toThrow('Download host not in allowlist');
  });

  it('should reject URLs with subdomain spoofing', () => {
    expect(() =>
      validateDownloadUrl(
        'https://huggingface.co.evil.com/model.onnx',
      ),
    ).toThrow('Download host not in allowlist');
  });

  it('should reject FTP protocol', () => {
    expect(() =>
      validateDownloadUrl('ftp://huggingface.co/model.onnx'),
    ).toThrow('Download URL must use HTTPS');
  });
});

// ---------------------------------------------------------------------------
// Path Traversal Defense
// ---------------------------------------------------------------------------

describe('validateModelPath', () => {
  it('should accept a simple relative path', () => {
    const result = validateModelPath('packages/ml/models/dinov2-base/model.onnx');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('packages/ml/models/dinov2-base/model.onnx');
  });

  it('should accept an absolute path under /tmp/', () => {
    const result = validateModelPath('/tmp/dinov2-test/model.onnx');
    expect(result).toBe('/tmp/dinov2-test/model.onnx');
  });

  it('should reject paths with .. traversal', () => {
    expect(() =>
      validateModelPath('../../../etc/passwd'),
    ).toThrow('Path traversal detected');
  });

  it('should reject paths with embedded .. segments', () => {
    expect(() =>
      validateModelPath('packages/ml/../../../etc/shadow'),
    ).toThrow('Path traversal detected');
  });

  it('should reject double-dot in middle of path', () => {
    expect(() =>
      validateModelPath('models/../../../tmp/exploit'),
    ).toThrow('Path traversal detected');
  });

  it('should accept a normal nested path', () => {
    const result = validateModelPath('packages/ml/models/dinov2-base/model.onnx');
    expect(result).not.toContain('..');
  });
});

// ---------------------------------------------------------------------------
// SHA-256 Hash Computation
// ---------------------------------------------------------------------------

describe('computeFileHash', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `dinov2-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'test.bin');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should compute correct SHA-256 for known content', async () => {
    const content = 'Hello, DINOv2!';
    writeFileSync(testFile, content);

    const expected = createHash('sha256')
      .update(content)
      .digest('hex');

    const result = await computeFileHash(testFile);
    expect(result).toBe(expected);
  });

  it('should compute correct SHA-256 for empty file', async () => {
    writeFileSync(testFile, '');

    const expected = createHash('sha256')
      .update('')
      .digest('hex');

    const result = await computeFileHash(testFile);
    expect(result).toBe(expected);
  });

  it('should compute correct SHA-256 for binary content', async () => {
    const binaryContent = Buffer.alloc(1024, 0xAB);
    writeFileSync(testFile, binaryContent);

    const expected = createHash('sha256')
      .update(binaryContent)
      .digest('hex');

    const result = await computeFileHash(testFile);
    expect(result).toBe(expected);
  });

  it('should reject non-existent file', async () => {
    await expect(
      computeFileHash('/tmp/nonexistent-dinov2-file.onnx'),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// File Size Validation
// ---------------------------------------------------------------------------

describe('validateFileSize', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `dinov2-size-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should accept a file under the size cap', () => {
    const filePath = path.join(testDir, 'small.bin');
    writeFileSync(filePath, Buffer.alloc(1024)); // 1 KB

    expect(() => validateFileSize(filePath)).not.toThrow();
  });

  it('should accept a file exactly at the size cap', () => {
    // Create a sparse file (does not allocate physical space)
    const filePath = path.join(testDir, 'exact.bin');
    const fd = openSync(filePath, 'w');
    // Use ftruncateSync to set file size without writing content
    ftruncateSync(fd, 500 * 1024 * 1024);
    closeSync(fd);

    expect(() => validateFileSize(filePath)).not.toThrow();
  });

  it('should reject a file exceeding the size cap', () => {
    // Create a sparse file slightly over 500 MB
    const filePath = path.join(testDir, 'oversized.bin');
    const fd = openSync(filePath, 'w');
    ftruncateSync(fd, 500 * 1024 * 1024 + 1);
    closeSync(fd);

    expect(() => validateFileSize(filePath)).toThrow(
      'Model file exceeds size cap',
    );
  });

  it('should reject non-existent file', () => {
    expect(() =>
      validateFileSize(path.join(testDir, 'nonexistent.bin')),
    ).toThrow();
  });
});
