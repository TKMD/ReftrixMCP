// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageIngestAdapter - DNS Retry Tests
 *
 * DNS不安定環境（EAI_AGAIN, ERR_NAME_NOT_RESOLVED等）でのリトライ機構テスト。
 *
 * 問題: ローカルDNSリゾルバが断続的にEAI_AGAINエラーを返し、
 * page.gotoが即座にfailedになる。一時的なDNS障害でジョブが永久に失敗扱いになる。
 *
 * 解決: Playwrightのpage.gotoでDNSエラー時にexponential backoffでリトライする。
 *
 * @module tests/services/page-ingest-dns-retry
 */

import { describe, it, expect } from 'vitest';
import {
  isDnsRelatedError,
  calculateRetryDelay,
  DNS_RETRY_CONFIG,
} from '../../src/services/page-ingest-adapter';

describe('PageIngestAdapter - DNS Retry', () => {
  // ==========================================================================
  // isDnsRelatedError
  // ==========================================================================

  describe('isDnsRelatedError', () => {
    it('ERR_NAME_NOT_RESOLVED をDNSエラーとして検出する', () => {
      const error = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com');
      expect(isDnsRelatedError(error)).toBe(true);
    });

    it('EAI_AGAIN をDNSエラーとして検出する', () => {
      const error = new Error('getaddrinfo EAI_AGAIN example.com');
      expect(isDnsRelatedError(error)).toBe(true);
    });

    it('ERR_NAME_RESOLUTION_FAILED をDNSエラーとして検出する', () => {
      const error = new Error('net::ERR_NAME_RESOLUTION_FAILED');
      expect(isDnsRelatedError(error)).toBe(true);
    });

    it('ENOTFOUND をDNSエラーとして検出する', () => {
      const error = new Error('getaddrinfo ENOTFOUND example.com');
      expect(isDnsRelatedError(error)).toBe(true);
    });

    it('DNS_PROBE_FINISHED_NXDOMAIN をDNSエラーとして検出する', () => {
      const error = new Error('net::ERR_DNS_PROBE_FINISHED_NXDOMAIN');
      expect(isDnsRelatedError(error)).toBe(false); // NXDOMAIN is permanent, not retryable
    });

    it('タイムアウトエラーはDNSエラーではない', () => {
      const error = new Error('page.goto: Timeout 30000ms exceeded.');
      expect(isDnsRelatedError(error)).toBe(false);
    });

    it('接続拒否エラーはDNSエラーではない', () => {
      const error = new Error('net::ERR_CONNECTION_REFUSED');
      expect(isDnsRelatedError(error)).toBe(false);
    });

    it('SSL証明書エラーはDNSエラーではない', () => {
      const error = new Error('net::ERR_CERT_AUTHORITY_INVALID');
      expect(isDnsRelatedError(error)).toBe(false);
    });

    it('空エラーメッセージはDNSエラーではない', () => {
      const error = new Error('');
      expect(isDnsRelatedError(error)).toBe(false);
    });

    it('Error以外の値を処理できる', () => {
      expect(isDnsRelatedError('some string error')).toBe(false);
      expect(isDnsRelatedError(null)).toBe(false);
      expect(isDnsRelatedError(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // calculateRetryDelay
  // ==========================================================================

  describe('calculateRetryDelay', () => {
    it('attempt 0 で基本遅延を返す', () => {
      const delay = calculateRetryDelay(0);
      expect(delay).toBe(DNS_RETRY_CONFIG.BASE_DELAY_MS);
    });

    it('attempt 1 で基本遅延 * 2 を返す', () => {
      const delay = calculateRetryDelay(1);
      expect(delay).toBe(DNS_RETRY_CONFIG.BASE_DELAY_MS * 2);
    });

    it('attempt 2 で基本遅延 * 4 を返す', () => {
      const delay = calculateRetryDelay(2);
      expect(delay).toBe(DNS_RETRY_CONFIG.BASE_DELAY_MS * 4);
    });

    it('大きなattempt番号でも最大遅延を超えない', () => {
      const delay = calculateRetryDelay(10);
      expect(delay).toBeLessThanOrEqual(DNS_RETRY_CONFIG.MAX_DELAY_MS);
    });
  });

  // ==========================================================================
  // DNS_RETRY_CONFIG
  // ==========================================================================

  describe('DNS_RETRY_CONFIG', () => {
    it('最大リトライ回数が3である', () => {
      expect(DNS_RETRY_CONFIG.MAX_RETRIES).toBe(3);
    });

    it('基本遅延が5000msである', () => {
      expect(DNS_RETRY_CONFIG.BASE_DELAY_MS).toBe(5000);
    });

    it('最大遅延が30000msを超えない', () => {
      expect(DNS_RETRY_CONFIG.MAX_DELAY_MS).toBeLessThanOrEqual(30000);
    });
  });
});
