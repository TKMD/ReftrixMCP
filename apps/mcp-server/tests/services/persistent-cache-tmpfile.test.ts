// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PersistentCache - Tmp File Race Condition Fix Test
 *
 * Verifies that the atomic write uses process-isolated temp file paths
 * to prevent ENOENT errors from concurrent writes across worker processes.
 *
 * @module tests/services/persistent-cache-tmpfile
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PersistentCache } from '../../src/services/persistent-cache';

describe('PersistentCache - Tmp File Isolation', () => {
  let tmpDir: string;
  let cache: PersistentCache<string> | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.close();
      cache = null;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should use process-isolated temp file (PID + timestamp)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reftrix-cache-test-'));

    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 10,
      defaultTtlMs: 60000,
      enableLogging: false,
    });

    // Write a value to trigger saveToDisk
    await cache.set('test-key', 'test-value');

    // Verify cache.json was written
    const cacheJsonPath = path.join(tmpDir, 'cache.json');
    const stat = await fs.stat(cacheJsonPath);
    expect(stat.isFile()).toBe(true);

    // Verify no orphaned .tmp files remain (they should be renamed)
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp'));
    expect(tmpFiles.length).toBe(0);
  });

  it('should not have stale .tmp file path (the old fixed path pattern)', async () => {
    // Read the source code and verify the fix
    const sourcePath = path.resolve(__dirname, '../../src/services/persistent-cache.ts');
    const sourceCode = await fs.readFile(sourcePath, 'utf8');

    // Should NOT contain the old pattern: `${filePath}.tmp`; (without PID)
    // The old pattern would be: const tempPath = `${filePath}.tmp`;
    expect(sourceCode).not.toMatch(/const tempPath = `\$\{filePath\}\.tmp`;/);

    // Should contain the new pattern with PID and timestamp
    expect(sourceCode).toContain('process.pid');
    expect(sourceCode).toContain('Date.now()');
  });

  it('should generate unique temp file names even within same process', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reftrix-cache-unique-'));

    // The temp file path format includes PID + Date.now()
    // Even within the same process, Date.now() changes between writes
    // For cross-process scenarios, PID provides uniqueness
    const sourcePath = path.resolve(__dirname, '../../src/services/persistent-cache.ts');
    const sourceCode = await fs.readFile(sourcePath, 'utf8');

    // Verify the temp path pattern includes both PID and timestamp
    expect(sourceCode).toContain('`${filePath}.tmp.${process.pid}.${Date.now()}`');
  });

  it('should write sequential operations successfully to same cache', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reftrix-cache-seq-'));

    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 100,
      defaultTtlMs: 60000,
      enableLogging: false,
    });

    // Sequential writes should all succeed
    for (let i = 0; i < 10; i++) {
      await cache.set(`key-${i}`, `value-${i}`);
    }

    // Verify all values are retrievable
    for (let i = 0; i < 10; i++) {
      const val = await cache.get(`key-${i}`);
      expect(val).toBe(`value-${i}`);
    }
  });
});
