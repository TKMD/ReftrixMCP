// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix Window拡張型テスト
 *
 * TDD Red Phase: 型定義が正しく動作することを確認するテスト
 *
 * @module tests/types/reftrix-window.test
 */

import { describe, it, expect, beforeEach } from 'vitest';

// TDD Green: 実際の型定義ファイルからインポート
import type {
  ReftrixWindow,
  ReftrixIOObserverInfo,
  ReftrixIOTriggerInfo,
  ReftrixRAFData,
  ReftrixRAFCallbackData,
} from '../../src/types/reftrix-window';

import {
  isReftrixIOObserverInfo,
  isReftrixRAFData,
  createEmptyRAFData,
  createRAFCallbackData,
} from '../../src/types/reftrix-window';

describe('Reftrix Window型拡張', () => {
  describe('型定義の存在確認', () => {
    it('ReftrixIOObserverInfo型が正しいプロパティを持つ', () => {
      // 型テスト: コンパイル時に検証される
      const observerInfo: ReftrixIOObserverInfo = {
        id: 1,
        targets: [],
        threshold: [0, 0.5, 1],
        rootMargin: '0px',
        root: undefined,
        targetSelectors: ['.element', '#id'],
      };

      expect(observerInfo.id).toBe(1);
      expect(observerInfo.threshold).toEqual([0, 0.5, 1]);
      expect(observerInfo.targetSelectors).toHaveLength(2);
    });

    it('ReftrixIOTriggerInfo型が正しいプロパティを持つ', () => {
      const triggerInfo: ReftrixIOTriggerInfo = {
        selector: '.animated-element',
        time: Date.now(),
        ratio: 0.75,
      };

      expect(triggerInfo.selector).toBe('.animated-element');
      expect(typeof triggerInfo.time).toBe('number');
      expect(triggerInfo.ratio).toBe(0.75);
    });

    it('ReftrixRAFCallbackData型が正しいプロパティを持つ', () => {
      const callbackData: ReftrixRAFCallbackData = {
        callCount: 60,
        frameTimes: [16.67, 16.5, 17.0],
        lastTime: performance.now(),
        modifiedElements: new Set(['.element1', '.element2']),
        isActive: true,
      };

      expect(callbackData.callCount).toBe(60);
      expect(callbackData.frameTimes).toHaveLength(3);
      expect(callbackData.modifiedElements.size).toBe(2);
      expect(callbackData.isActive).toBe(true);
    });

    it('ReftrixRAFData型が正しいプロパティを持つ', () => {
      const rafData: ReftrixRAFData = {
        callbacks: new Map(),
        nextId: 1,
      };

      rafData.callbacks.set(1, {
        callCount: 10,
        frameTimes: [16.67],
        lastTime: performance.now(),
        modifiedElements: new Set(),
        isActive: true,
      });

      expect(rafData.callbacks.size).toBe(1);
      expect(rafData.nextId).toBe(1);
    });
  });

  describe('Window拡張の型安全性', () => {
    // ブラウザ環境をシミュレート
    let mockWindow: ReftrixWindow;

    beforeEach(() => {
      mockWindow = {
        __reftrix_io_observers: [],
        __reftrix_io_hooked: false,
        __reftrix_io_triggers: [],
        __reftrix_raf_hooked: false,
        __reftrix_raf_data: undefined,
      } as ReftrixWindow;
    });

    it('__reftrix_io_observers に ReftrixIOObserverInfo[] を設定できる', () => {
      const observers: ReftrixIOObserverInfo[] = [
        {
          id: 1,
          targets: [],
          threshold: [0],
          rootMargin: '0px',
          root: undefined,
          targetSelectors: [],
        },
      ];

      mockWindow.__reftrix_io_observers = observers;

      expect(mockWindow.__reftrix_io_observers).toHaveLength(1);
      expect(mockWindow.__reftrix_io_observers?.[0].id).toBe(1);
    });

    it('__reftrix_io_hooked は boolean 型である', () => {
      mockWindow.__reftrix_io_hooked = true;
      expect(mockWindow.__reftrix_io_hooked).toBe(true);
    });

    it('__reftrix_io_triggers に ReftrixIOTriggerInfo[] を設定できる', () => {
      mockWindow.__reftrix_io_triggers = [
        { selector: '.test', time: Date.now(), ratio: 1 },
      ];

      expect(mockWindow.__reftrix_io_triggers).toHaveLength(1);
    });

    it('__reftrix_raf_hooked は boolean 型である', () => {
      mockWindow.__reftrix_raf_hooked = true;
      expect(mockWindow.__reftrix_raf_hooked).toBe(true);
    });

    it('__reftrix_raf_data に ReftrixRAFData を設定できる', () => {
      mockWindow.__reftrix_raf_data = {
        callbacks: new Map(),
        nextId: 1,
      };

      expect(mockWindow.__reftrix_raf_data?.nextId).toBe(1);
    });
  });

  describe('型ガード関数', () => {
    it('isReftrixIOObserverInfo が正しく判定する', () => {
      const valid: ReftrixIOObserverInfo = {
        id: 1,
        targets: [],
        threshold: [0],
        rootMargin: '0px',
        root: undefined,
        targetSelectors: [],
      };

      const invalid = {
        id: 'string', // 無効: number であるべき
        targets: [],
      };

      expect(isReftrixIOObserverInfo(valid)).toBe(true);
      expect(isReftrixIOObserverInfo(invalid)).toBe(false);
      expect(isReftrixIOObserverInfo(null)).toBe(false);
      expect(isReftrixIOObserverInfo(undefined)).toBe(false);
    });

    it('isReftrixRAFData が正しく判定する', () => {
      const valid: ReftrixRAFData = {
        callbacks: new Map(),
        nextId: 1,
      };

      const invalid = {
        callbacks: [], // 無効: Map であるべき
        nextId: 1,
      };

      expect(isReftrixRAFData(valid)).toBe(true);
      expect(isReftrixRAFData(invalid)).toBe(false);
    });
  });

  describe('ユーティリティ関数', () => {
    it('createEmptyRAFData が正しい初期値を返す', () => {
      const rafData = createEmptyRAFData();

      expect(rafData.callbacks).toBeInstanceOf(Map);
      expect(rafData.callbacks.size).toBe(0);
      expect(rafData.nextId).toBe(1);
    });

    it('createRAFCallbackData が正しい初期値を返す', () => {
      const callbackData = createRAFCallbackData();

      expect(callbackData.callCount).toBe(0);
      expect(callbackData.frameTimes).toEqual([]);
      expect(callbackData.modifiedElements).toBeInstanceOf(Set);
      expect(callbackData.isActive).toBe(true);
    });
  });
});

// TDD Green: プレースホルダーは削除され、実際の型定義ファイルからインポート済み
