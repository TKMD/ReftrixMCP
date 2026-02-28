// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Utils Unit Tests
 *
 * Tests for shared utility functions in image-utils.ts
 *
 * Covers:
 * - parseImageInput (without size validation)
 * - hexToRgb / rgbToHex color conversions
 * - colorDistance calculation
 * - calculateBrightness / calculateSaturation
 * - parseHexColor
 *
 * @module tests/services/visual-extractor/image-utils.test
 */

import { describe, it, expect } from 'vitest';
import {
  parseImageInput,
  hexToRgb,
  rgbToHex,
  colorDistance,
  calculateBrightness,
  calculateSaturation,
  parseHexColor,
  type RGB,
} from '../../../src/services/visual-extractor/image-utils';

describe('Image Utils Unit Tests', () => {
  describe('parseImageInput', () => {
    describe('Buffer input', () => {
      it('should return valid non-empty buffer as-is', () => {
        const input = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
        const result = parseImageInput(input);
        expect(result).toEqual(input);
      });

      it('should throw for empty buffer', () => {
        const input = Buffer.alloc(0);
        expect(() => parseImageInput(input)).toThrow('Empty image buffer');
      });

      it('should throw for null input', () => {
        expect(() => parseImageInput(null as unknown as Buffer)).toThrow('Image input is required');
      });

      it('should throw for undefined input', () => {
        expect(() => parseImageInput(undefined as unknown as Buffer)).toThrow('Image input is required');
      });
    });

    describe('Base64 string input', () => {
      it('should decode valid base64 string', () => {
        const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const base64 = original.toString('base64');
        const result = parseImageInput(base64);
        expect(result).toEqual(original);
      });

      it('should handle base64 with data URL prefix', () => {
        const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const dataUrl = `data:image/png;base64,${original.toString('base64')}`;
        const result = parseImageInput(dataUrl);
        expect(result).toEqual(original);
      });

      it('should handle base64 with various data URL prefixes', () => {
        const original = Buffer.from([0xff, 0xd8, 0xff]);
        const dataUrlJpeg = `data:image/jpeg;base64,${original.toString('base64')}`;
        const result = parseImageInput(dataUrlJpeg);
        expect(result).toEqual(original);
      });

      it('should throw for invalid base64 string', () => {
        expect(() => parseImageInput('not!valid@base64')).toThrow('Invalid base64 string');
      });

      it('should throw for empty base64 that decodes to empty buffer', () => {
        expect(() => parseImageInput('')).toThrow('Image input is required');
      });
    });

    describe('Invalid input types', () => {
      it('should throw for number input', () => {
        expect(() => parseImageInput(123 as unknown as Buffer)).toThrow('Invalid image input type');
      });

      it('should throw for object input', () => {
        expect(() => parseImageInput({} as unknown as Buffer)).toThrow('Invalid image input type');
      });

      it('should throw for array input', () => {
        expect(() => parseImageInput([] as unknown as Buffer)).toThrow('Invalid image input type');
      });
    });
  });

  describe('hexToRgb', () => {
    it('should convert valid hex with # prefix', () => {
      expect(hexToRgb('#FF0000')).toEqual([255, 0, 0]);
      expect(hexToRgb('#00FF00')).toEqual([0, 255, 0]);
      expect(hexToRgb('#0000FF')).toEqual([0, 0, 255]);
    });

    it('should convert valid hex without # prefix', () => {
      expect(hexToRgb('FF0000')).toEqual([255, 0, 0]);
      expect(hexToRgb('00FF00')).toEqual([0, 255, 0]);
      expect(hexToRgb('0000FF')).toEqual([0, 0, 255]);
    });

    it('should handle lowercase hex', () => {
      expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
      expect(hexToRgb('abcdef')).toEqual([171, 205, 239]);
    });

    it('should handle mixed case hex', () => {
      expect(hexToRgb('#AbCdEf')).toEqual([171, 205, 239]);
    });

    it('should convert black and white', () => {
      expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
      expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
    });

    it('should throw for invalid hex string', () => {
      expect(() => hexToRgb('invalid')).toThrow('Invalid hex color');
      expect(() => hexToRgb('#12345')).toThrow('Invalid hex color'); // 5 chars
      expect(() => hexToRgb('#1234567')).toThrow('Invalid hex color'); // 7 chars
      expect(() => hexToRgb('#GGGGGG')).toThrow('Invalid hex color'); // invalid chars
    });
  });

  describe('rgbToHex', () => {
    it('should convert RGB to hex with # prefix', () => {
      expect(rgbToHex(255, 0, 0)).toBe('#FF0000');
      expect(rgbToHex(0, 255, 0)).toBe('#00FF00');
      expect(rgbToHex(0, 0, 255)).toBe('#0000FF');
    });

    it('should handle black and white', () => {
      expect(rgbToHex(0, 0, 0)).toBe('#000000');
      expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
    });

    it('should handle values that need zero padding', () => {
      expect(rgbToHex(1, 2, 3)).toBe('#010203');
      expect(rgbToHex(10, 20, 30)).toBe('#0A141E');
    });

    it('should clamp values over 255', () => {
      expect(rgbToHex(300, 256, 1000)).toBe('#FFFFFF');
    });

    it('should clamp values under 0', () => {
      expect(rgbToHex(-10, -1, -255)).toBe('#000000');
    });

    it('should round floating point values', () => {
      // 127.4 -> 127 -> 0x7F
      // 127.6 -> 128 -> 0x80
      // 127.5 -> 128 -> 0x80 (Math.round rounds 0.5 up)
      expect(rgbToHex(127.4, 127.6, 127.5)).toBe('#7F8080');
    });
  });

  describe('colorDistance', () => {
    it('should return 0 for identical colors', () => {
      const color1: RGB = [100, 150, 200];
      const color2: RGB = [100, 150, 200];
      expect(colorDistance(color1, color2)).toBe(0);
    });

    it('should return correct distance for black and white', () => {
      const black: RGB = [0, 0, 0];
      const white: RGB = [255, 255, 255];
      const expected = Math.sqrt(255 * 255 * 3); // ~441.67
      expect(colorDistance(black, white)).toBeCloseTo(expected, 2);
    });

    it('should return correct distance for single channel difference', () => {
      const color1: RGB = [100, 100, 100];
      const color2: RGB = [200, 100, 100];
      expect(colorDistance(color1, color2)).toBe(100);
    });

    it('should be symmetric', () => {
      const color1: RGB = [50, 100, 150];
      const color2: RGB = [200, 75, 25];
      expect(colorDistance(color1, color2)).toBe(colorDistance(color2, color1));
    });
  });

  describe('calculateBrightness', () => {
    it('should return 0 for black', () => {
      expect(calculateBrightness(0, 0, 0)).toBe(0);
    });

    it('should return 255 for white', () => {
      expect(calculateBrightness(255, 255, 255)).toBeCloseTo(255, 1);
    });

    it('should weight green highest (perceived luminance)', () => {
      // For equal RGB values, green contributes most
      const redOnly = calculateBrightness(255, 0, 0);
      const greenOnly = calculateBrightness(0, 255, 0);
      const blueOnly = calculateBrightness(0, 0, 255);

      expect(greenOnly).toBeGreaterThan(redOnly);
      expect(redOnly).toBeGreaterThan(blueOnly);
    });

    it('should calculate mid-gray correctly', () => {
      const result = calculateBrightness(128, 128, 128);
      expect(result).toBeCloseTo(128, 1);
    });

    it('should use correct formula (0.299R + 0.587G + 0.114B)', () => {
      const r = 100, g = 150, b = 200;
      const expected = r * 0.299 + g * 0.587 + b * 0.114;
      expect(calculateBrightness(r, g, b)).toBeCloseTo(expected, 5);
    });
  });

  describe('calculateSaturation', () => {
    it('should return 0 for grayscale colors', () => {
      expect(calculateSaturation(128, 128, 128)).toBe(0);
      expect(calculateSaturation(0, 0, 0)).toBe(0);
      expect(calculateSaturation(255, 255, 255)).toBe(0);
    });

    it('should return 1 for fully saturated red', () => {
      expect(calculateSaturation(255, 0, 0)).toBe(1);
    });

    it('should return 1 for fully saturated green', () => {
      expect(calculateSaturation(0, 255, 0)).toBe(1);
    });

    it('should return 1 for fully saturated blue', () => {
      expect(calculateSaturation(0, 0, 255)).toBe(1);
    });

    it('should return 0.5 for mid-saturation color', () => {
      // R=255, G=127, B=127: max=255, min=127, saturation = (255-127)/255 = 0.502
      expect(calculateSaturation(255, 127, 127)).toBeCloseTo(0.502, 2);
    });

    it('should handle pure black (max=0 case)', () => {
      expect(calculateSaturation(0, 0, 0)).toBe(0);
    });
  });

  describe('parseHexColor', () => {
    it('should return object with r, g, b properties', () => {
      const result = parseHexColor('#FF5500');
      expect(result).toHaveProperty('r');
      expect(result).toHaveProperty('g');
      expect(result).toHaveProperty('b');
    });

    it('should parse red correctly', () => {
      const result = parseHexColor('#FF0000');
      expect(result).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should parse green correctly', () => {
      const result = parseHexColor('#00FF00');
      expect(result).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should parse blue correctly', () => {
      const result = parseHexColor('#0000FF');
      expect(result).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should work without # prefix', () => {
      const result = parseHexColor('AABBCC');
      expect(result).toEqual({ r: 170, g: 187, b: 204 });
    });

    it('should throw for invalid hex', () => {
      expect(() => parseHexColor('invalid')).toThrow();
      expect(() => parseHexColor('#GGG')).toThrow();
    });
  });

  describe('Round-trip conversions', () => {
    it('hexToRgb -> rgbToHex should return original (uppercase)', () => {
      const original = '#AABBCC';
      const [r, g, b] = hexToRgb(original);
      const result = rgbToHex(r, g, b);
      expect(result).toBe(original);
    });

    it('parseHexColor and hexToRgb should return equivalent values', () => {
      const hex = '#FF8800';
      const parsed = parseHexColor(hex);
      const tuple = hexToRgb(hex);
      expect(tuple).toEqual([parsed.r, parsed.g, parsed.b]);
    });
  });
});
