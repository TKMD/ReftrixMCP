// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Vector Estimator
 *
 * Pure JavaScript/TypeScript implementation of optical flow estimation
 * for detecting motion vectors (direction and speed) between frames.
 *
 * Phase5: Motion Vector Estimator - TDD Implementation
 *
 * Algorithm: Block Matching with Lucas-Kanade inspired gradient analysis
 * - Divides frames into blocks
 * - Calculates motion vectors for each block using pixel differences
 * - Aggregates vectors to determine dominant motion direction and speed
 *
 * @module @reftrix/mcp-server/services/motion/analyzers/motion-vector.estimator
 */

import sharp from 'sharp';
import type {
  IMotionVectorEstimator,
  MotionVectorResult,
  MotionType,
} from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/**
 * Block motion result
 */
interface BlockMotion {
  dx: number;
  dy: number;
  confidence: number;
}

/**
 * Estimator options
 */
export interface MotionVectorEstimatorOptions {
  /** Block size for motion estimation (default: 16) */
  blockSize?: number;
  /** Search range for block matching (default: 16) */
  searchRange?: number;
  /** Minimum motion threshold in pixels (default: 2) */
  minMotionThreshold?: number;
  /** Confidence threshold for valid motion (default: 0.3) */
  confidenceThreshold?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OPTIONS: Required<MotionVectorEstimatorOptions> = {
  blockSize: 16,
  searchRange: 16,
  minMotionThreshold: 2,
  confidenceThreshold: 0.3,
};

// Direction ranges for motion type classification (in degrees)
const DIRECTION_RANGES = {
  right: { min: -45, max: 45 },
  down: { min: 45, max: 135 },
  left: { min: 135, max: 180, minAlt: -180, maxAlt: -135 },
  up: { min: -135, max: -45 },
};

// ============================================================================
// MotionVectorEstimator Class
// ============================================================================

/**
 * Motion Vector Estimator implementation using block matching algorithm
 *
 * Implements IMotionVectorEstimator interface from types.ts
 */
export class MotionVectorEstimator implements IMotionVectorEstimator {
  private readonly options: Required<MotionVectorEstimatorOptions>;
  private frameIndex: number = 0;

  constructor(options?: MotionVectorEstimatorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Estimate optical flow between two frames
   *
   * @param frame1 - First frame buffer (raw RGBA)
   * @param frame2 - Second frame buffer (raw RGBA)
   * @returns MotionVectorResult with direction, speed, and motion type
   */
  async estimateFlow(
    frame1: Buffer,
    frame2: Buffer
  ): Promise<MotionVectorResult> {
    // Validate input
    if (!frame1 || frame1.length === 0) {
      throw new Error('Invalid frame1: empty buffer');
    }
    if (!frame2 || frame2.length === 0) {
      throw new Error('Invalid frame2: empty buffer');
    }

    // Get frame dimensions and raw data
    const { data: data1, info: info1 } = await this.getFrameData(frame1);
    const { data: data2, info: info2 } = await this.getFrameData(frame2);

    // Validate dimensions match
    if (info1.width !== info2.width || info1.height !== info2.height) {
      throw new Error(
        `Frame dimension mismatch: ${info1.width}x${info1.height} vs ${info2.width}x${info2.height}`
      );
    }

    const width = info1.width;
    const height = info1.height;

    // Calculate motion vectors using block matching
    const blockMotions = this.calculateBlockMotions(
      data1,
      data2,
      width,
      height
    );

    // Aggregate motion vectors
    const aggregated = this.aggregateMotions(blockMotions);

    // Determine motion type based on aggregated vectors
    const motionType = this.classifyMotionFromAggregate(
      aggregated,
      blockMotions
    );

    // Increment frame index for next call
    const currentFrameIndex = this.frameIndex++;

    return {
      frameIndex: currentFrameIndex,
      dominantDirection: aggregated.dominantDirection,
      avgSpeed: aggregated.avgSpeed,
      maxSpeed: aggregated.maxSpeed,
      confidence: aggregated.confidence,
      motionType,
    };
  }

  /**
   * Classify overall motion type from multiple vector results
   *
   * @param vectors - Array of MotionVectorResult
   * @returns Dominant MotionType
   */
  classifyMotion(vectors: MotionVectorResult[]): MotionType {
    if (vectors.length === 0) {
      return 'static';
    }

    // Count motion types weighted by confidence
    const typeScores = new Map<MotionType, number>();

    for (const vec of vectors) {
      const currentScore = typeScores.get(vec.motionType) ?? 0;
      typeScores.set(vec.motionType, currentScore + vec.confidence);
    }

    // Check if all static
    const staticScore = typeScores.get('static') ?? 0;
    const totalScore = Array.from(typeScores.values()).reduce(
      (a, b) => a + b,
      0
    );

    if (staticScore === totalScore) {
      return 'static';
    }

    // Find dominant type (excluding static)
    let maxScore = 0;
    let dominantType: MotionType = 'static';
    let secondMaxScore = 0;

    for (const [type, score] of typeScores.entries()) {
      if (type !== 'static') {
        if (score > maxScore) {
          secondMaxScore = maxScore;
          maxScore = score;
          dominantType = type;
        } else if (score > secondMaxScore) {
          secondMaxScore = score;
        }
      }
    }

    // Check for complex motion (multiple significant types)
    const nonStaticTypes = Array.from(typeScores.entries()).filter(
      ([type, score]) => type !== 'static' && score > 0
    );

    if (nonStaticTypes.length >= 3) {
      // Check if scores are relatively close (complex motion)
      const avgNonStaticScore =
        nonStaticTypes.reduce((sum, [, score]) => sum + score, 0) /
        nonStaticTypes.length;
      const allSimilar = nonStaticTypes.every(
        ([, score]) =>
          score >= avgNonStaticScore * 0.5 && score <= avgNonStaticScore * 2
      );

      if (allSimilar) {
        return 'complex';
      }
    }

    // If second score is close to max, consider complex
    if (
      secondMaxScore > 0 &&
      secondMaxScore >= maxScore * 0.7 &&
      nonStaticTypes.length >= 2
    ) {
      // Different directions suggest complex motion
      const types = nonStaticTypes.map(([t]) => t);
      if (this.areOppositeDirections(types)) {
        return 'complex';
      }
    }

    return dominantType;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get raw frame data with dimensions
   */
  private async getFrameData(
    buffer: Buffer
  ): Promise<{ data: Uint8Array; info: { width: number; height: number } }> {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width === 0 || height === 0) {
      throw new Error('Invalid frame dimensions');
    }

    // Convert to raw RGBA
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(data),
      info: { width: info.width, height: info.height },
    };
  }

  /**
   * Calculate motion vectors for all blocks
   */
  private calculateBlockMotions(
    data1: Uint8Array,
    data2: Uint8Array,
    width: number,
    height: number
  ): BlockMotion[] {
    const blockSize = Math.min(this.options.blockSize, Math.min(width, height));
    const searchRange = Math.min(
      this.options.searchRange,
      Math.min(width, height) / 2
    );

    const motions: BlockMotion[] = [];

    // Iterate through blocks
    for (let by = 0; by < height - blockSize; by += blockSize) {
      for (let bx = 0; bx < width - blockSize; bx += blockSize) {
        const motion = this.findBestMatch(
          data1,
          data2,
          width,
          height,
          bx,
          by,
          blockSize,
          searchRange
        );
        motions.push(motion);
      }
    }

    return motions;
  }

  /**
   * Find best matching block using Sum of Absolute Differences (SAD)
   */
  private findBestMatch(
    data1: Uint8Array,
    data2: Uint8Array,
    width: number,
    height: number,
    blockX: number,
    blockY: number,
    blockSize: number,
    searchRange: number
  ): BlockMotion {
    let bestDx = 0;
    let bestDy = 0;
    let bestSAD = Infinity;
    let secondBestSAD = Infinity;

    // Calculate SAD for original position
    const originalSAD = this.calculateSAD(
      data1,
      data2,
      width,
      blockX,
      blockY,
      blockX,
      blockY,
      blockSize
    );

    // Search for best match in search range
    for (let dy = -searchRange; dy <= searchRange; dy++) {
      for (let dx = -searchRange; dx <= searchRange; dx++) {
        const targetX = blockX + dx;
        const targetY = blockY + dy;

        // Check bounds
        if (
          targetX < 0 ||
          targetX + blockSize > width ||
          targetY < 0 ||
          targetY + blockSize > height
        ) {
          continue;
        }

        const sad = this.calculateSAD(
          data1,
          data2,
          width,
          blockX,
          blockY,
          targetX,
          targetY,
          blockSize
        );

        if (sad < bestSAD) {
          secondBestSAD = bestSAD;
          bestSAD = sad;
          bestDx = dx;
          bestDy = dy;
        } else if (sad < secondBestSAD) {
          secondBestSAD = sad;
        }
      }
    }

    // Calculate confidence based on SAD ratio
    // Higher confidence when there's a clear best match
    let confidence = 0;
    if (bestSAD < originalSAD && secondBestSAD > 0) {
      // Good match found that's better than no motion
      confidence = Math.min(1, (secondBestSAD - bestSAD) / (secondBestSAD + 1));
    } else if (bestSAD < originalSAD * 0.5) {
      // Very good match
      confidence = 0.8;
    }

    // Reduce confidence for very small motions
    const magnitude = Math.sqrt(bestDx * bestDx + bestDy * bestDy);
    if (magnitude < this.options.minMotionThreshold) {
      confidence *= 0.2;
    }

    return { dx: bestDx, dy: bestDy, confidence };
  }

  /**
   * Calculate Sum of Absolute Differences between two blocks
   */
  private calculateSAD(
    data1: Uint8Array,
    data2: Uint8Array,
    width: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    blockSize: number
  ): number {
    let sad = 0;

    for (let y = 0; y < blockSize; y++) {
      for (let x = 0; x < blockSize; x++) {
        const idx1 = ((y1 + y) * width + (x1 + x)) * 4;
        const idx2 = ((y2 + y) * width + (x2 + x)) * 4;

        // Compare RGB values (skip alpha)
        for (let c = 0; c < 3; c++) {
          const val1 = data1[idx1 + c] ?? 0;
          const val2 = data2[idx2 + c] ?? 0;
          sad += Math.abs(val1 - val2);
        }
      }
    }

    return sad;
  }

  /**
   * Aggregate block motions into overall motion characteristics
   */
  private aggregateMotions(motions: BlockMotion[]): {
    dominantDirection: number;
    avgSpeed: number;
    maxSpeed: number;
    confidence: number;
  } {
    if (motions.length === 0) {
      return {
        dominantDirection: 0,
        avgSpeed: 0,
        maxSpeed: 0,
        confidence: 0,
      };
    }

    // Filter motions with sufficient confidence
    const significantMotions = motions.filter(
      (m) => m.confidence >= this.options.confidenceThreshold
    );

    if (significantMotions.length === 0) {
      return {
        dominantDirection: 0,
        avgSpeed: 0,
        maxSpeed: 0,
        confidence: 0,
      };
    }

    // Calculate weighted average direction
    let totalDx = 0;
    let totalDy = 0;
    let totalWeight = 0;
    let maxSpeed = 0;

    for (const motion of significantMotions) {
      const weight = motion.confidence;
      totalDx += motion.dx * weight;
      totalDy += motion.dy * weight;
      totalWeight += weight;

      const speed = Math.sqrt(motion.dx * motion.dx + motion.dy * motion.dy);
      maxSpeed = Math.max(maxSpeed, speed);
    }

    // Calculate dominant direction (in degrees, 0 = right, 90 = down, -90 = up, +/-180 = left)
    const avgDx = totalDx / totalWeight;
    const avgDy = totalDy / totalWeight;
    const dominantDirection = Math.atan2(avgDy, avgDx) * (180 / Math.PI);

    // Calculate average speed
    const avgSpeed = Math.sqrt(avgDx * avgDx + avgDy * avgDy);

    // Calculate overall confidence
    const avgConfidence =
      significantMotions.reduce((sum, m) => sum + m.confidence, 0) /
      significantMotions.length;
    const coverageRatio = significantMotions.length / motions.length;
    const confidence = avgConfidence * coverageRatio;

    return {
      dominantDirection,
      avgSpeed,
      maxSpeed,
      confidence,
    };
  }

  /**
   * Classify motion type from aggregated vectors
   */
  private classifyMotionFromAggregate(
    aggregated: {
      dominantDirection: number;
      avgSpeed: number;
      maxSpeed: number;
      confidence: number;
    },
    blockMotions: BlockMotion[]
  ): MotionType {
    // Check for static (no significant motion)
    if (
      aggregated.avgSpeed < this.options.minMotionThreshold ||
      aggregated.confidence < this.options.confidenceThreshold
    ) {
      return 'static';
    }

    // Check for zoom (radial motion)
    const zoomType = this.detectZoom(blockMotions);
    if (zoomType) {
      return zoomType;
    }

    // Check for rotation
    const rotationType = this.detectRotation(blockMotions);
    if (rotationType) {
      return rotationType;
    }

    // Classify based on dominant direction
    const dir = aggregated.dominantDirection;

    if (this.isInRange(dir, DIRECTION_RANGES.right)) {
      return 'slide_right';
    }
    if (this.isInRange(dir, DIRECTION_RANGES.down)) {
      return 'slide_down';
    }
    if (
      this.isInRange(dir, DIRECTION_RANGES.left) ||
      this.isInRangeAlt(
        dir,
        DIRECTION_RANGES.left.minAlt!,
        DIRECTION_RANGES.left.maxAlt!
      )
    ) {
      return 'slide_left';
    }
    if (this.isInRange(dir, DIRECTION_RANGES.up)) {
      return 'slide_up';
    }

    return 'complex';
  }

  /**
   * Detect zoom motion (radial pattern)
   */
  private detectZoom(motions: BlockMotion[]): MotionType | null {
    if (motions.length < 4) return null;

    // Calculate center of all blocks (approximate frame center)
    const significantMotions = motions.filter(
      (m) => m.confidence >= this.options.confidenceThreshold
    );
    if (significantMotions.length < 4) return null;

    // For zoom detection, we need to check if motions radiate from/toward center
    // This is a simplified check - look at the pattern of dx, dy values

    // Check for zoom_in: objects should be moving outward from center
    // (positive dx in right half, negative dx in left half, etc.)
    let zoomInCount = 0;
    let zoomOutCount = 0;

    // Get grid dimensions
    const gridSize = Math.ceil(Math.sqrt(motions.length));
    const centerBlock = Math.floor(gridSize / 2);

    let idx = 0;
    for (let row = 0; row < gridSize && idx < motions.length; row++) {
      for (let col = 0; col < gridSize && idx < motions.length; col++) {
        const motion = motions[idx];
        if (!motion || motion.confidence < this.options.confidenceThreshold) {
          idx++;
          continue;
        }

        // Calculate expected direction for zoom
        const relCol = col - centerBlock;
        const relRow = row - centerBlock;

        // For zoom_in: motion should be in same direction as position from center
        // For zoom_out: motion should be opposite to position from center
        const expectedDx = relCol > 0 ? 1 : relCol < 0 ? -1 : 0;
        const expectedDy = relRow > 0 ? 1 : relRow < 0 ? -1 : 0;

        const actualDx = motion.dx > 0 ? 1 : motion.dx < 0 ? -1 : 0;
        const actualDy = motion.dy > 0 ? 1 : motion.dy < 0 ? -1 : 0;

        // Check if motion matches zoom pattern
        const isZoomIn =
          (expectedDx === 0 || actualDx === expectedDx) &&
          (expectedDy === 0 || actualDy === expectedDy);
        const isZoomOut =
          (expectedDx === 0 || actualDx === -expectedDx) &&
          (expectedDy === 0 || actualDy === -expectedDy);

        if (isZoomIn && (motion.dx !== 0 || motion.dy !== 0)) {
          zoomInCount++;
        }
        if (isZoomOut && (motion.dx !== 0 || motion.dy !== 0)) {
          zoomOutCount++;
        }

        idx++;
      }
    }

    const threshold = significantMotions.length * 0.5;

    if (zoomInCount >= threshold) {
      return 'zoom_in';
    }
    if (zoomOutCount >= threshold) {
      return 'zoom_out';
    }

    return null;
  }

  /**
   * Detect rotation motion
   */
  private detectRotation(motions: BlockMotion[]): MotionType | null {
    if (motions.length < 4) return null;

    const significantMotions = motions.filter(
      (m) => m.confidence >= this.options.confidenceThreshold
    );
    if (significantMotions.length < 4) return null;

    // For rotation detection, check if motion vectors are perpendicular to radial direction
    // This is a simplified check

    const gridSize = Math.ceil(Math.sqrt(motions.length));
    const centerBlock = Math.floor(gridSize / 2);

    let clockwiseCount = 0;
    let counterClockwiseCount = 0;

    let idx = 0;
    for (let row = 0; row < gridSize && idx < motions.length; row++) {
      for (let col = 0; col < gridSize && idx < motions.length; col++) {
        const motion = motions[idx];
        if (!motion || motion.confidence < this.options.confidenceThreshold) {
          idx++;
          continue;
        }

        const relCol = col - centerBlock;
        const relRow = row - centerBlock;

        // For clockwise rotation: motion should be perpendicular to radial direction
        // At top: motion should be right (+dx)
        // At right: motion should be down (+dy)
        // At bottom: motion should be left (-dx)
        // At left: motion should be up (-dy)

        // Expected perpendicular direction for clockwise
        const expectedDxCW = -relRow;
        const expectedDyCW = relCol;

        const dotProduct = motion.dx * expectedDxCW + motion.dy * expectedDyCW;

        if (dotProduct > 0) {
          clockwiseCount++;
        } else if (dotProduct < 0) {
          counterClockwiseCount++;
        }

        idx++;
      }
    }

    const threshold = significantMotions.length * 0.5;

    if (clockwiseCount >= threshold || counterClockwiseCount >= threshold) {
      return 'rotation';
    }

    return null;
  }

  /**
   * Check if direction is in specified range
   */
  private isInRange(
    direction: number,
    range: { min: number; max: number }
  ): boolean {
    return direction >= range.min && direction <= range.max;
  }

  /**
   * Check if direction is in alternate range (for left direction which spans +/-180)
   */
  private isInRangeAlt(direction: number, min: number, max: number): boolean {
    return direction >= min && direction <= max;
  }

  /**
   * Check if motion types include opposite directions
   */
  private areOppositeDirections(types: MotionType[]): boolean {
    const hasLeft = types.includes('slide_left');
    const hasRight = types.includes('slide_right');
    const hasUp = types.includes('slide_up');
    const hasDown = types.includes('slide_down');
    const hasZoomIn = types.includes('zoom_in');
    const hasZoomOut = types.includes('zoom_out');

    return (
      (hasLeft && hasRight) ||
      (hasUp && hasDown) ||
      (hasZoomIn && hasZoomOut)
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new MotionVectorEstimator instance
 */
export function createMotionVectorEstimator(
  options?: MotionVectorEstimatorOptions
): IMotionVectorEstimator {
  return new MotionVectorEstimator(options);
}
