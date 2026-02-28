// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Utilities for Visual Extractor Services
 *
 * Provides common validation, size limits, and timeout utilities
 * for secure image processing.
 *
 * Security features:
 * - Input size validation (5MB max)
 * - Processing timeout (30s default)
 * - Base64 validation
 *
 * @module services/visual-extractor/image-utils
 */

import { logger } from '../../utils/logger';

/**
 * Maximum allowed image size in bytes (5MB)
 * This limit ensures safe processing within 512MB memory constraint
 */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Default processing timeout in milliseconds (30 seconds)
 */
export const DEFAULT_PROCESSING_TIMEOUT = 30_000; // 30s

/**
 * Error thrown when image size exceeds the maximum allowed size
 */
export class ImageSizeExceededError extends Error {
  constructor(actualSize: number, maxSize: number = MAX_IMAGE_SIZE) {
    const actualMB = (actualSize / 1024 / 1024).toFixed(2);
    const maxMB = (maxSize / 1024 / 1024).toFixed(0);
    super(`Image size (${actualMB}MB) exceeds maximum allowed size (${maxMB}MB)`);
    this.name = 'ImageSizeExceededError';
  }
}

/**
 * Error thrown when processing times out
 */
export class ProcessingTimeoutError extends Error {
  constructor(timeoutMs: number = DEFAULT_PROCESSING_TIMEOUT) {
    super(`Processing timeout after ${timeoutMs}ms`);
    this.name = 'ProcessingTimeoutError';
  }
}

/**
 * Validate image buffer size
 *
 * @param buffer - Image buffer to validate
 * @param maxSize - Maximum allowed size in bytes (default: 5MB)
 * @throws ImageSizeExceededError if buffer exceeds max size
 */
export function validateImageSize(
  buffer: Buffer,
  maxSize: number = MAX_IMAGE_SIZE
): void {
  if (buffer.length > maxSize) {
    throw new ImageSizeExceededError(buffer.length, maxSize);
  }
}

/**
 * Parse and validate input image to Buffer with size check
 *
 * @param image - Image as Buffer or Base64 string
 * @param maxSize - Maximum allowed size in bytes (default: 5MB)
 * @returns Validated image buffer
 * @throws Error if image is invalid or exceeds size limit
 */
export function parseAndValidateImageInput(
  image: Buffer | string,
  maxSize: number = MAX_IMAGE_SIZE
): Buffer {
  if (!image) {
    throw new Error('Image input is required');
  }

  let buffer: Buffer;

  if (Buffer.isBuffer(image)) {
    if (image.length === 0) {
      throw new Error('Empty image buffer');
    }
    buffer = image;
  } else if (typeof image === 'string') {
    // Remove data URL prefix if present
    let base64Data = image;
    if (image.includes('base64,')) {
      const parts = image.split('base64,');
      base64Data = parts[1] ?? '';
    }

    // Validate base64 format
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(base64Data)) {
      throw new Error('Invalid base64 string');
    }

    buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0) {
      throw new Error('Empty image buffer from base64');
    }
  } else {
    throw new Error('Invalid image input type');
  }

  // Validate size after parsing
  validateImageSize(buffer, maxSize);

  return buffer;
}

/**
 * Wrap a promise with a timeout
 *
 * @param promise - Promise to wrap
 * @param timeoutMs - Timeout in milliseconds (default: 30s)
 * @returns Promise that rejects on timeout
 * @throws ProcessingTimeoutError if timeout is exceeded
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_PROCESSING_TIMEOUT
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ProcessingTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return result;
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw error;
  }
}

/**
 * Log security-related events in development mode
 */
export function logSecurityEvent(
  service: string,
  event: string,
  details?: Record<string, unknown>
): void {
  logger.debug(`[Security:${service}] ${event}`, details ?? '');
}

/** RGB color tuple type */
export type RGB = [number, number, number];

/**
 * Parse input image to Buffer (without size validation)
 *
 * Use parseAndValidateImageInput for full validation with size check.
 *
 * @param image - Image as Buffer or Base64 string
 * @returns Parsed image buffer
 * @throws Error if input is invalid
 */
export function parseImageInput(image: Buffer | string): Buffer {
  if (!image) {
    throw new Error('Image input is required');
  }

  if (Buffer.isBuffer(image)) {
    if (image.length === 0) {
      throw new Error('Empty image buffer');
    }
    return image;
  }

  if (typeof image === 'string') {
    // Remove data URL prefix if present
    let base64Data = image;
    if (image.includes('base64,')) {
      const parts = image.split('base64,');
      base64Data = parts[1] ?? '';
    }

    // Validate base64
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(base64Data)) {
      throw new Error('Invalid base64 string');
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0) {
      throw new Error('Empty image buffer from base64');
    }
    return buffer;
  }

  throw new Error('Invalid image input type');
}

/**
 * Convert HEX color to RGB tuple
 *
 * @param hex - Color in HEX format (#RRGGBB or RRGGBB)
 * @returns RGB tuple [r, g, b]
 * @throws Error if hex format is invalid
 */
export function hexToRgb(hex: string): RGB {
  const cleanHex = hex.replace('#', '');

  if (!/^[0-9A-Fa-f]{6}$/.test(cleanHex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return [r, g, b];
}

/**
 * Convert RGB values to HEX format
 *
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Color in HEX format (#RRGGBB, uppercase)
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number): string => {
    const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Calculate Euclidean distance between two colors
 *
 * @param color1 - First RGB color
 * @param color2 - Second RGB color
 * @returns Distance value (0-441.67 for RGB)
 */
export function colorDistance(color1: RGB, color2: RGB): number {
  return Math.sqrt(
    Math.pow(color1[0] - color2[0], 2) +
    Math.pow(color1[1] - color2[1], 2) +
    Math.pow(color1[2] - color2[2], 2)
  );
}

/**
 * Calculate brightness of a color using perceived luminance weights
 *
 * Uses the formula: 0.299*R + 0.587*G + 0.114*B
 *
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Brightness value (0-255)
 */
export function calculateBrightness(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/**
 * Calculate color saturation (HSV model)
 *
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Saturation value (0-1)
 */
export function calculateSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

/**
 * Parse HEX color to RGB object
 *
 * @param hexColor - Color in HEX format (#RRGGBB or RRGGBB)
 * @returns RGB object with r, g, b properties
 * @throws Error if hex format is invalid
 */
export function parseHexColor(hexColor: string): { r: number; g: number; b: number } {
  const [r, g, b] = hexToRgb(hexColor);
  return { r, g, b };
}

/**
 * Check if an error is a Sharp/vips image processing error
 *
 * @param error - Error to check
 * @returns true if the error is from Sharp/vips image processing
 */
export function isSharpImageError(error: Error): boolean {
  const message = error.message;
  return (
    message.includes('Input buffer') ||
    message.includes('unsupported image format') ||
    message.includes('Input file') ||
    message.includes('VipsJpeg') ||
    message.includes('vips')
  );
}

/**
 * Wrap Sharp/vips errors as a generic "Invalid image data" error
 *
 * @param error - Original error
 * @returns Wrapped error with cleaner message, or original error
 */
export function wrapSharpError(error: unknown): Error {
  if (error instanceof Error && isSharpImageError(error)) {
    return new Error('Invalid image data');
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error('Unknown image processing error');
}
