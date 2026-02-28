// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Category Classifier Service
 *
 * Responsible for classifying CSS animations/transitions into categories
 * and inferring trigger types based on selectors and properties.
 *
 * Extracted from motion-detector.service.ts (Phase6 refactoring)
 *
 * @module services/page/motion-category-classifier.service
 */

import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// Types
// =====================================================

/** Trigger type for animations */
export type TriggerType =
  | 'hover'
  | 'focus'
  | 'click'
  | 'scroll'
  | 'intersection'
  | 'load'
  | 'unknown';

/** Motion category for classification */
export type MotionCategory =
  | 'scroll_trigger'
  | 'hover_effect'
  | 'page_transition'
  | 'loading_state'
  | 'navigation'
  | 'feedback'
  | 'micro_interaction'
  | 'attention_grabber'
  | 'entrance'
  | 'exit'
  // New categories added in v0.1.0 for improved classification
  | 'marquee'
  | 'video_overlay'
  | 'parallax'
  | 'reveal'
  | 'morphing'
  | 'background_animation'
  | 'typing_animation'
  | 'unknown';

// =====================================================
// Category Classification Rules (Table-Driven)
// =====================================================

/**
 * Classification rule definition
 * Priority is determined by array order (lower index = higher priority)
 */
interface CategoryRule {
  /** Target category */
  category: MotionCategory;
  /** Check function - returns true if rule matches */
  match: (ctx: CategoryContext) => boolean;
}

/**
 * Context passed to classification rules
 */
interface CategoryContext {
  nameLower: string;
  selectorLower: string;
  propNames: string[];
  iterations: number | 'infinite';
}

/**
 * Category classification rules in priority order
 *
 * This table-driven approach replaces the if-else chain in inferCategory,
 * reducing cyclomatic complexity and improving maintainability.
 *
 * Each rule is evaluated in order until a match is found.
 *
 * v0.1.0: Added new categories for improved classification:
 * - marquee: Infinite horizontal scrolling animations
 * - video_overlay: Video player overlay animations
 * - parallax: Depth/parallax scrolling effects
 * - reveal: Fade-in/slide-in reveal animations
 * - morphing: SVG path morphing animations
 * - background_animation: Background position/gradient animations
 * - typing_animation: Typewriter/cursor animations
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  // Priority 1: Typing animation (cursor, typewriter)
  // Must be before loading_state to catch cursor-blink with 'infinite'
  {
    category: 'typing_animation',
    match: (ctx) =>
      /typing|typewriter|cursor|caret/i.test(ctx.nameLower) ||
      /cursor|caret/i.test(ctx.selectorLower) ||
      ctx.propNames.some((p) => p === 'letter-spacing' || p === 'width') &&
        /type|text/i.test(ctx.nameLower),
  },
  // Priority 2: Marquee (infinite horizontal scrolling)
  // Must be before loading_state to distinguish from regular infinite animations
  {
    category: 'marquee',
    match: (ctx) =>
      /marquee|ticker|scroll-left|scroll-right|infinite-scroll|auto-scroll/i.test(ctx.nameLower) ||
      /marquee|ticker/i.test(ctx.selectorLower) ||
      (ctx.iterations === 'infinite' &&
        (ctx.propNames.includes('transform') || ctx.propNames.includes('translatex')) &&
        (/ticker|slider|carousel|marquee|scroll/i.test(ctx.selectorLower) ||
          /slide-text|carousel|loop|continuous/i.test(ctx.nameLower))),
  },
  // Priority 3: Loading state (loading-related names/selectors ONLY)
  // NOTE: Previously caught ALL infinite iterations, causing massive over-classification.
  // Now requires name/selector hints in addition to infinite iterations.
  {
    category: 'loading_state',
    match: (ctx) =>
      /spin|rotate|pulse|skeleton|loading|loader|progress|buffering/i.test(ctx.nameLower) ||
      /spinner|loading|skeleton|loader|progress/i.test(ctx.selectorLower) ||
      (ctx.iterations === 'infinite' &&
        /spin|rotate|pulse|dot|circle|ring|wave/i.test(ctx.nameLower)),
  },
  // Priority 4: Video overlay
  {
    category: 'video_overlay',
    match: (ctx) =>
      /video[-_]?overlay|media[-_]?overlay|player[-_]?overlay/i.test(ctx.nameLower) ||
      /video|player[-_]?controls|media[-_]?overlay/i.test(ctx.selectorLower),
  },
  // Priority 5: Hover effect
  {
    category: 'hover_effect',
    match: (ctx) =>
      ctx.selectorLower.includes(':hover') ||
      /\bhover\b/i.test(ctx.nameLower) ||
      (/link|anchor|card/i.test(ctx.selectorLower) &&
        ctx.propNames.some((p) => p === 'color' || p === 'background-color' || p === 'box-shadow')),
  },
  // Priority 6: Parallax
  {
    category: 'parallax',
    match: (ctx) =>
      /parallax|depth[-_]?effect|layer[-_]?shift/i.test(ctx.nameLower) ||
      /parallax/i.test(ctx.selectorLower),
  },
  // Priority 7: Morphing (SVG path animations)
  {
    category: 'morphing',
    match: (ctx) =>
      /morph|shape[-_]?morph|path[-_]?animation|blob[-_]?morph|clip[-_]?morph/i.test(ctx.nameLower) ||
      ctx.propNames.includes('d') ||
      /svg[-_]?path|morph/i.test(ctx.selectorLower),
  },
  // Priority 8: Background animation
  {
    category: 'background_animation',
    match: (ctx) =>
      /background[-_]?shift|gradient[-_]?move|bg[-_]?anim|color[-_]?shift|gradient[-_]?anim/i.test(ctx.nameLower) ||
      ctx.propNames.some((p) =>
        p.includes('background-position') || p === 'background' || p === 'background-color' || p === 'filter',
      ) &&
        (ctx.iterations === 'infinite' || /bg|background|gradient/i.test(ctx.nameLower)) ||
      /bg[-_]?animated/i.test(ctx.selectorLower),
  },
  // Priority 9: Scroll trigger (explicit scroll-related names/classes)
  {
    category: 'scroll_trigger',
    match: (ctx) =>
      /scroll[-_]?anim|on[-_]?scroll|scroll[-_]?trigger|scroll[-_]?reveal|scroll[-_]?fade/i.test(ctx.nameLower) ||
      /scroll[-_]?animate|scroll[-_]?effect|data-scroll/i.test(ctx.selectorLower),
  },
  // Priority 10: Reveal (fade-in, slide-in reveal animations) - EXPANDED
  {
    category: 'reveal',
    match: (ctx): boolean => {
      // Direct name matches
      if (/reveal|fade[-_]?in|slide[-_]?up|slide[-_]?in|animate[-_]?in|text[-_]?reveal|zoom[-_]?in|scale[-_]?in|grow[-_]?in/i.test(ctx.nameLower)) {
        return true;
      }
      // Compound keyword detection: names containing fade/slide + directional hints
      if (/fade|slide|move|drift|fly|pop|lift|rise|emerge|unveil|unfold/i.test(ctx.nameLower) &&
        ctx.propNames.some((p) => p === 'opacity' || p === 'transform' || p === 'clip-path')) {
        return true;
      }
      // IntersectionObserver / visibility related selectors
      if (/visible|in-view|intersect|active|is-visible|aos-animate|animate/i.test(ctx.selectorLower) &&
        ctx.propNames.some((p) => p === 'opacity' || p === 'transform')) {
        return true;
      }
      // Property-based: opacity + transform combination (common reveal pattern)
      if (ctx.propNames.includes('opacity') && ctx.propNames.includes('transform') &&
        ctx.iterations !== 'infinite') {
        return true;
      }
      return false;
    },
  },
  // Priority 11: Page transition (specific page/route transitions, NOT generic CSS transitions)
  {
    category: 'page_transition',
    match: (ctx) =>
      /page[-_]?transition|route[-_]?change|view[-_]?transition|page[-_]?enter|page[-_]?leave/i.test(ctx.nameLower) ||
      (/\b(page|route|view)\b/i.test(ctx.nameLower) && /transition|change|swap/i.test(ctx.nameLower)),
  },
  // Priority 12: Navigation
  {
    category: 'navigation',
    match: (ctx) =>
      /menu|nav\b|sidebar|drawer|hamburger|mobile[-_]?menu|dropdown/i.test(ctx.selectorLower) ||
      /menu[-_]?open|menu[-_]?close|nav[-_]?slide|drawer[-_]?open|hamburger/i.test(ctx.nameLower),
  },
  // Priority 13: Feedback
  {
    category: 'feedback',
    match: (ctx) =>
      /button|btn|submit|click|input|form|checkbox|radio|toggle|switch/i.test(ctx.selectorLower) ||
      /ripple|press|tap|click[-_]?effect|success|error|warning|check/i.test(ctx.nameLower) ||
      ctx.selectorLower.includes(':active'),
  },
  // Priority 14: Micro interaction
  {
    category: 'micro_interaction',
    match: (ctx) =>
      /bounce|shake|wiggle|jiggle|wobble|swing|rubber|elastic|pop|snap|tick/i.test(ctx.nameLower) ||
      (/icon|badge|chip|tag|tooltip|popover/i.test(ctx.selectorLower) &&
        ctx.propNames.some((p) => p === 'transform' || p === 'scale')),
  },
  // Priority 15: Attention grabber
  {
    category: 'attention_grabber',
    match: (ctx) =>
      /attention|flash|blink|glow|pulse[-_]?glow|shimmer|shine|sparkle|highlight|beacon/i.test(ctx.nameLower) ||
      (ctx.propNames.some((p) => p === 'box-shadow' || p === 'text-shadow') &&
        ctx.iterations === 'infinite'),
  },
  // Priority 16: Entrance (non-infinite animations with entrance-like names)
  {
    category: 'entrance',
    match: (ctx) =>
      ctx.iterations !== 'infinite' &&
      (/\benter\b|\bin$|\bappear\b|\bshow\b|\bopen\b|\bexpand\b|\bunfold\b/i.test(ctx.nameLower)),
  },
  // Priority 17: Exit
  {
    category: 'exit',
    match: (ctx) =>
      /\bexit\b|\bout$|\bleave\b|\bhide\b|\bclose\b|\bcollapse\b|\bshrink\b|\bfold\b|\bdismiss\b/i.test(ctx.nameLower),
  },
  // Priority 18: Property-based fallback for remaining infinite animations
  {
    category: 'background_animation',
    match: (ctx) =>
      ctx.iterations === 'infinite' &&
      ctx.propNames.some((p) =>
        p === 'background-color' || p === 'background-position' ||
        p === 'filter' || p === 'background',
      ),
  },
  // Priority 19: Infinite transform animations (not caught above) → likely attention/decoration
  {
    category: 'attention_grabber',
    match: (ctx) =>
      ctx.iterations === 'infinite' &&
      ctx.propNames.some((p) => p === 'transform' || p === 'opacity'),
  },
  // Priority 20: Selector-based semantic fallback
  {
    category: 'reveal',
    match: (ctx) =>
      /section|content|block|card|item|feature|panel|slide/i.test(ctx.selectorLower) &&
      ctx.propNames.some((p) => p === 'opacity' || p === 'transform') &&
      ctx.iterations !== 'infinite',
  },
  // Priority 21: CSS transition with opacity/transform (non-infinite) → likely reveal/feedback
  {
    category: 'feedback',
    match: (ctx) =>
      /a\b|link|anchor/i.test(ctx.selectorLower) &&
      ctx.propNames.some((p) => p === 'color' || p === 'opacity' || p === 'background-color'),
  },
] as const;

// =====================================================
// MotionCategoryClassifier Class
// =====================================================

/**
 * MotionCategoryClassifier - Classifies motion patterns into categories
 *
 * Singleton pattern for efficient reuse across detection operations.
 */
export class MotionCategoryClassifier {
  private static instance: MotionCategoryClassifier | null = null;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    if (isDevelopment()) {
      logger.debug('[MotionCategoryClassifier] Instance created');
    }
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): MotionCategoryClassifier {
    if (!MotionCategoryClassifier.instance) {
      MotionCategoryClassifier.instance = new MotionCategoryClassifier();
    }
    return MotionCategoryClassifier.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    MotionCategoryClassifier.instance = null;
    if (isDevelopment()) {
      logger.debug('[MotionCategoryClassifier] Instance reset');
    }
  }

  /**
   * Infer trigger type from selector and properties
   *
   * Priority order:
   * 1. Pseudo-class selectors (:hover, :focus, :active)
   * 2. Scroll-related class names
   * 3. Intersection Observer related class names
   * 4. Property-based inference (opacity, transform -> load)
   * 5. Default: unknown
   *
   * @param selector - CSS selector string
   * @param properties - Array of animated CSS property names
   * @returns Inferred trigger type
   */
  inferTriggerType(selector: string, properties: string[]): TriggerType {
    // Priority 1: Pseudo-class selectors
    // :hover
    if (selector.includes(':hover')) return 'hover';
    // :focus or :focus-visible
    if (selector.includes(':focus')) return 'focus';
    // :active (click)
    if (selector.includes(':active')) return 'click';

    // Priority 2: Scroll-related classes
    if (/scroll|parallax|sticky/i.test(selector)) return 'scroll';

    // Priority 3: Intersection Observer related
    if (/visible|in-view|intersect/i.test(selector)) return 'intersection';

    // Priority 4: Property-based inference
    if (properties.some((p) => p.includes('opacity') || p.includes('transform'))) {
      return 'load';
    }

    return 'unknown';
  }

  /**
   * Infer category from animation characteristics
   *
   * Uses table-driven classification for improved maintainability.
   * Priority order (see CATEGORY_RULES):
   * 1. Loading state (infinite iterations or loading-related names/selectors)
   * 2. Hover effect (:hover selector or hover in name)
   * 3. Scroll trigger (fade-in, slide-in, scroll, reveal, appear patterns)
   * 4. Page transition (page, route, transition, morph patterns)
   * 5. Navigation (menu, nav, sidebar, drawer selectors)
   * 6. Feedback (button, btn, submit, click selectors)
   * 7. Micro interaction (bounce, shake, wiggle, jiggle)
   * 8. Attention grabber (attention, flash, blink, glow)
   * 9. Entrance (enter, *in$, appear, show)
   * 10. Exit (exit, *out$, leave, hide)
   * 11. Default: unknown
   *
   * @param name - Animation name
   * @param selector - CSS selector
   * @param properties - Animated properties
   * @param iterations - Number of iterations or 'infinite'
   * @returns Inferred motion category
   */
  inferCategory(
    name: string,
    selector: string,
    properties: string[],
    iterations: number | 'infinite'
  ): MotionCategory {
    // Build context for rule evaluation
    const ctx: CategoryContext = {
      nameLower: name.toLowerCase(),
      selectorLower: selector.toLowerCase(),
      propNames: properties.map((p) => p.toLowerCase()),
      iterations,
    };

    // Evaluate rules in priority order
    for (const rule of CATEGORY_RULES) {
      if (rule.match(ctx)) {
        return rule.category;
      }
    }

    return 'unknown';
  }
}

// =====================================================
// Factory Functions
// =====================================================

/**
 * Get the MotionCategoryClassifier singleton instance
 */
export function getMotionCategoryClassifier(): MotionCategoryClassifier {
  return MotionCategoryClassifier.getInstance();
}

/**
 * Reset the MotionCategoryClassifier singleton instance (for testing)
 */
export function resetMotionCategoryClassifier(): void {
  MotionCategoryClassifier.resetInstance();
}
