// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * start-workers.ts - Process Error Handlers Test
 *
 * Tests for uncaughtException and unhandledRejection handlers
 * that prevent silent worker death via shared handleFatalError().
 *
 * @module tests/scripts/start-workers-handlers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('start-workers.ts - Process Error Handlers', () => {
  const startWorkersPath = path.resolve(
    __dirname,
    '../../src/scripts/start-workers.ts'
  );

  let sourceCode: string;

  beforeEach(() => {
    sourceCode = fs.readFileSync(startWorkersPath, 'utf8');
  });

  describe('Handler Registration', () => {
    it('should register uncaughtException handler', () => {
      expect(sourceCode).toContain("process.on('uncaughtException'");
    });

    it('should register unhandledRejection handler', () => {
      expect(sourceCode).toContain("process.on('unhandledRejection'");
    });

    it('should use shared handleFatalError for uncaughtException', () => {
      const exceptionHandlerSection = sourceCode.slice(
        sourceCode.indexOf("process.on('uncaughtException'"),
        sourceCode.indexOf("process.on('unhandledRejection'")
      );
      expect(exceptionHandlerSection).toContain('handleFatalError');
    });

    it('should use shared handleFatalError for unhandledRejection', () => {
      const rejectionStart = sourceCode.indexOf("process.on('unhandledRejection'");
      const rejectionSection = sourceCode.slice(
        rejectionStart,
        sourceCode.indexOf('try {', rejectionStart)
      );
      expect(rejectionSection).toContain('handleFatalError');
    });
  });

  describe('handleFatalError Implementation', () => {
    let handleFatalErrorSection: string;

    beforeEach(() => {
      const start = sourceCode.indexOf('function handleFatalError');
      const end = sourceCode.indexOf("process.on('uncaughtException'", start);
      handleFatalErrorSection = sourceCode.slice(start, end);
    });

    it('should call shutdownWorkers in handleFatalError', () => {
      expect(handleFatalErrorSection).toContain('shutdownWorkers()');
    });

    it('should have 10 second shutdown timeout', () => {
      expect(handleFatalErrorSection).toContain('10000');
    });

    it('should call process.exit(1) after shutdown', () => {
      expect(handleFatalErrorSection).toContain('process.exit(1)');
    });

    it('should unref the shutdown timeout to not prevent process exit', () => {
      expect(handleFatalErrorSection).toContain('.unref()');
    });

    it('should log error message and stack trace', () => {
      expect(handleFatalErrorSection).toContain('console.error');
      expect(handleFatalErrorSection).toContain('Stack:');
    });
  });

  describe('Existing Signal Handlers', () => {
    it('should still have SIGINT handler', () => {
      expect(sourceCode).toContain("process.on('SIGINT'");
    });

    it('should still have SIGTERM handler', () => {
      expect(sourceCode).toContain("process.on('SIGTERM'");
    });
  });

  describe('Grade type import', () => {
    it('should import Grade type from schemas instead of local declaration', () => {
      expect(sourceCode).toContain("import type { Grade } from '../tools/quality/schemas'");
      // Should NOT have local type declaration
      expect(sourceCode).not.toContain("type Grade = 'A' | 'B' | 'C' | 'D' | 'F'");
    });
  });
});
