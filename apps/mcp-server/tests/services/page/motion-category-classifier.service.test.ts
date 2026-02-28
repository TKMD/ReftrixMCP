// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionCategoryClassifier Service Tests
 *
 * TDD Red Phase - Tests for motion category classification and trigger type inference
 * Extracted from motion-detector.ts (Phase6 refactoring)
 *
 * @module tests/services/page/motion-category-classifier.service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  MotionCategoryClassifier} from '../../../src/services/page/motion-category-classifier.service';
import {
  getMotionCategoryClassifier,
  resetMotionCategoryClassifier,
  type TriggerType,
  type MotionCategory,
} from '../../../src/services/page/motion-category-classifier.service';

describe('MotionCategoryClassifier', () => {
  let classifier: MotionCategoryClassifier;

  beforeEach(() => {
    resetMotionCategoryClassifier();
    classifier = getMotionCategoryClassifier();
  });

  // =====================================================
  // Singleton Pattern Tests
  // =====================================================

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = getMotionCategoryClassifier();
      const instance2 = getMotionCategoryClassifier();

      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after reset', () => {
      const instance1 = getMotionCategoryClassifier();
      resetMotionCategoryClassifier();
      const instance2 = getMotionCategoryClassifier();

      expect(instance1).not.toBe(instance2);
    });
  });

  // =====================================================
  // inferTriggerType Tests
  // =====================================================

  describe('inferTriggerType', () => {
    describe('pseudo-class detection', () => {
      it('should return "hover" for :hover selector', () => {
        const result = classifier.inferTriggerType('.button:hover', []);

        expect(result).toBe('hover');
      });

      it('should return "focus" for :focus selector', () => {
        const result = classifier.inferTriggerType('input:focus', []);

        expect(result).toBe('focus');
      });

      it('should return "focus" for :focus-visible selector', () => {
        const result = classifier.inferTriggerType('.link:focus-visible', []);

        expect(result).toBe('focus');
      });

      it('should return "click" for :active selector', () => {
        const result = classifier.inferTriggerType('.btn:active', []);

        expect(result).toBe('click');
      });
    });

    describe('scroll-related detection', () => {
      it('should return "scroll" for scroll class', () => {
        const result = classifier.inferTriggerType('.scroll-animation', []);

        expect(result).toBe('scroll');
      });

      it('should return "scroll" for parallax class', () => {
        const result = classifier.inferTriggerType('.parallax-effect', []);

        expect(result).toBe('scroll');
      });

      it('should return "scroll" for sticky class', () => {
        const result = classifier.inferTriggerType('.sticky-header', []);

        expect(result).toBe('scroll');
      });
    });

    describe('intersection observer detection', () => {
      it('should return "intersection" for visible class', () => {
        const result = classifier.inferTriggerType('.is-visible', []);

        expect(result).toBe('intersection');
      });

      it('should return "intersection" for in-view class', () => {
        const result = classifier.inferTriggerType('.in-view', []);

        expect(result).toBe('intersection');
      });

      it('should return "intersection" for intersect class', () => {
        const result = classifier.inferTriggerType('.intersect-animate', []);

        expect(result).toBe('intersection');
      });
    });

    describe('property-based inference', () => {
      it('should return "load" for opacity property', () => {
        const result = classifier.inferTriggerType('.fade', ['opacity']);

        expect(result).toBe('load');
      });

      it('should return "load" for transform property', () => {
        const result = classifier.inferTriggerType('.slide', ['transform']);

        expect(result).toBe('load');
      });

      it('should return "load" for opacity and transform combined', () => {
        const result = classifier.inferTriggerType('.animate', [
          'opacity',
          'transform',
        ]);

        expect(result).toBe('load');
      });
    });

    describe('default behavior', () => {
      it('should return "unknown" for unrecognized selector and properties', () => {
        const result = classifier.inferTriggerType('.custom-class', [
          'background-color',
          'border',
        ]);

        expect(result).toBe('unknown');
      });

      it('should return "unknown" for empty selector and properties', () => {
        const result = classifier.inferTriggerType('', []);

        expect(result).toBe('unknown');
      });
    });

    describe('priority handling', () => {
      it('should prioritize :hover over scroll class', () => {
        // :hover has higher specificity than class names
        const result = classifier.inferTriggerType('.scroll:hover', []);

        expect(result).toBe('hover');
      });

      it('should prioritize :active over property inference', () => {
        const result = classifier.inferTriggerType('.fade:active', ['opacity']);

        expect(result).toBe('click');
      });
    });
  });

  // =====================================================
  // inferCategory Tests
  // =====================================================

  describe('inferCategory', () => {
    describe('loading_state category', () => {
      it('should return "reveal" for fadeIn with infinite iterations (no loading hint)', () => {
        // v6.x: loading_state requires name/selector hints (spin, rotate, pulse, etc.)
        // fadeIn matches reveal pattern, even with infinite iterations
        const result = classifier.inferCategory('fadeIn', '.element', [], 'infinite');

        expect(result).toBe('reveal');
      });

      it('should return "loading_state" for spin animation name', () => {
        const result = classifier.inferCategory('spin', '.element', [], 1);

        expect(result).toBe('loading_state');
      });

      it('should return "loading_state" for rotate animation name', () => {
        const result = classifier.inferCategory('rotate-icon', '.element', [], 1);

        expect(result).toBe('loading_state');
      });

      it('should return "loading_state" for pulse animation name', () => {
        const result = classifier.inferCategory('pulse', '.element', [], 1);

        expect(result).toBe('loading_state');
      });

      it('should return "loading_state" for skeleton animation name', () => {
        const result = classifier.inferCategory('skeleton-loading', '.element', [], 1);

        expect(result).toBe('loading_state');
      });

      it('should return "loading_state" for loading selector', () => {
        const result = classifier.inferCategory('fadeIn', '.loading', [], 1);

        expect(result).toBe('loading_state');
      });

      it('should return "loading_state" for spinner selector', () => {
        const result = classifier.inferCategory('rotate', '.spinner', [], 1);

        expect(result).toBe('loading_state');
      });
    });

    describe('hover_effect category', () => {
      it('should return "hover_effect" for :hover selector', () => {
        const result = classifier.inferCategory('scale-up', '.button:hover', [], 1);

        expect(result).toBe('hover_effect');
      });

      it('should return "hover_effect" for hover animation name', () => {
        const result = classifier.inferCategory('hover-effect', '.button', [], 1);

        expect(result).toBe('hover_effect');
      });
    });

    describe('scroll_trigger category', () => {
      // Note: v0.1.0 split scroll_trigger into more specific categories (reveal, entrance)
      // scroll_trigger is now reserved for scroll-specific class names
      it('should return "scroll_trigger" for scroll animation name', () => {
        const result = classifier.inferCategory('scroll-animation', '.element', [], 1);

        expect(result).toBe('scroll_trigger');
      });

      it('should return "scroll_trigger" for scroll-reveal animation name', () => {
        const result = classifier.inferCategory('scroll-reveal', '.element', [], 1);

        // scroll_trigger has higher priority than reveal for scroll-* names
        expect(result).toBe('scroll_trigger');
      });

      it('should return "scroll_trigger" for on-scroll animation name', () => {
        const result = classifier.inferCategory('on-scroll', '.element', [], 1);

        expect(result).toBe('scroll_trigger');
      });

      // Legacy tests updated to reflect new category split:
      // fade-in, fadeIn, reveal -> 'reveal' category
      // slide-in, appear -> 'entrance' category
      // opacity + transform alone -> more specific category or unknown
    });

    describe('page_transition category', () => {
      it('should return "page_transition" for page animation name', () => {
        const result = classifier.inferCategory('page-enter', '.element', [], 1);

        expect(result).toBe('page_transition');
      });

      it('should return "page_transition" for route animation name', () => {
        const result = classifier.inferCategory('route-change', '.element', [], 1);

        expect(result).toBe('page_transition');
      });

      it('should return "unknown" for generic transition animation name (not page/route/view specific)', () => {
        // v6.x: page_transition requires page/route/view keywords, not just 'transition'
        const result = classifier.inferCategory('transition-fade', '.element', [], 1);

        expect(result).toBe('unknown');
      });

      // Note: 'morph' is now classified as 'morphing' category in v0.1.0
      it('should return "morphing" for morph animation name', () => {
        const result = classifier.inferCategory('morph-shape', '.element', [], 1);

        expect(result).toBe('morphing');
      });
    });

    describe('navigation category', () => {
      it('should return "navigation" for menu selector', () => {
        const result = classifier.inferCategory('slide', '.menu', [], 1);

        expect(result).toBe('navigation');
      });

      it('should return "navigation" for nav selector', () => {
        const result = classifier.inferCategory('slide', '.nav', [], 1);

        expect(result).toBe('navigation');
      });

      it('should return "navigation" for sidebar selector', () => {
        const result = classifier.inferCategory('slide', '.sidebar', [], 1);

        expect(result).toBe('navigation');
      });

      it('should return "navigation" for drawer selector', () => {
        const result = classifier.inferCategory('slide', '.drawer', [], 1);

        expect(result).toBe('navigation');
      });
    });

    describe('feedback category', () => {
      it('should return "feedback" for button selector', () => {
        const result = classifier.inferCategory('press', '.button', [], 1);

        expect(result).toBe('feedback');
      });

      it('should return "feedback" for btn selector', () => {
        const result = classifier.inferCategory('press', '.btn', [], 1);

        expect(result).toBe('feedback');
      });

      it('should return "feedback" for submit selector', () => {
        const result = classifier.inferCategory('press', '.submit', [], 1);

        expect(result).toBe('feedback');
      });

      it('should return "feedback" for click selector', () => {
        const result = classifier.inferCategory('press', '.click-handler', [], 1);

        expect(result).toBe('feedback');
      });
    });

    describe('micro_interaction category', () => {
      it('should return "micro_interaction" for bounce animation name', () => {
        const result = classifier.inferCategory('bounce', '.element', [], 1);

        expect(result).toBe('micro_interaction');
      });

      it('should return "micro_interaction" for shake animation name', () => {
        const result = classifier.inferCategory('shake', '.element', [], 1);

        expect(result).toBe('micro_interaction');
      });

      it('should return "micro_interaction" for wiggle animation name', () => {
        const result = classifier.inferCategory('wiggle', '.element', [], 1);

        expect(result).toBe('micro_interaction');
      });

      it('should return "micro_interaction" for jiggle animation name', () => {
        const result = classifier.inferCategory('jiggle', '.element', [], 1);

        expect(result).toBe('micro_interaction');
      });
    });

    describe('attention_grabber category', () => {
      it('should return "attention_grabber" for attention animation name', () => {
        const result = classifier.inferCategory('attention', '.element', [], 1);

        expect(result).toBe('attention_grabber');
      });

      it('should return "attention_grabber" for flash animation name', () => {
        const result = classifier.inferCategory('flash', '.element', [], 1);

        expect(result).toBe('attention_grabber');
      });

      it('should return "attention_grabber" for blink animation name', () => {
        const result = classifier.inferCategory('blink', '.element', [], 1);

        expect(result).toBe('attention_grabber');
      });

      it('should return "attention_grabber" for glow animation name', () => {
        const result = classifier.inferCategory('glow', '.element', [], 1);

        expect(result).toBe('attention_grabber');
      });
    });

    describe('entrance category', () => {
      it('should return "entrance" for enter animation name', () => {
        const result = classifier.inferCategory('enter', '.element', [], 1);

        expect(result).toBe('entrance');
      });

      it('should return "unknown" for camelCase animation name ending with "In" (no word boundary in lowercase)', () => {
        // v6.x: 'dropIn' lowercases to 'dropin', and \bin$ requires word boundary
        // 'dropin' has no word boundary before 'in', so entrance pattern doesn't match
        const result = classifier.inferCategory('dropIn', '.element', [], 1);

        expect(result).toBe('unknown');
      });

      it('should return "entrance" for appear animation name', () => {
        // Note: 'appear' matches entrance regex /enter|in$|appear|show/
        const result = classifier.inferCategory('slide-appear', '.element', [], 1);

        // 'appear' is matched by entrance pattern
        expect(result).toBe('entrance');
      });

      it('should return "entrance" for show animation name', () => {
        const result = classifier.inferCategory('show-element', '.element', [], 1);

        expect(result).toBe('entrance');
      });
    });

    describe('exit category', () => {
      it('should return "exit" for exit animation name', () => {
        const result = classifier.inferCategory('exit', '.element', [], 1);

        expect(result).toBe('exit');
      });

      it('should return "unknown" for camelCase animation name ending with "Out" (no word boundary in lowercase)', () => {
        // v6.x: 'slideOut' lowercases to 'slideout', and \bout$ requires word boundary
        // 'slideout' has no word boundary before 'out', so exit pattern doesn't match
        const result = classifier.inferCategory('slideOut', '.element', [], 1);

        expect(result).toBe('unknown');
      });

      it('should return "exit" for leave animation name', () => {
        const result = classifier.inferCategory('leave', '.element', [], 1);

        expect(result).toBe('exit');
      });

      it('should return "exit" for hide animation name', () => {
        const result = classifier.inferCategory('hide-element', '.element', [], 1);

        expect(result).toBe('exit');
      });
    });

    // =====================================================
    // New Categories for ax1.vc patterns (v0.1.0)
    // =====================================================

    describe('marquee category', () => {
      it('should return "marquee" for marquee animation name', () => {
        const result = classifier.inferCategory('marquee', '.element', ['transform'], 'infinite');

        expect(result).toBe('marquee');
      });

      it('should return "marquee" for scroll-left animation name', () => {
        const result = classifier.inferCategory('scroll-left', '.element', ['transform'], 'infinite');

        expect(result).toBe('marquee');
      });

      it('should return "marquee" for ticker animation name', () => {
        const result = classifier.inferCategory('ticker', '.element', ['transform'], 'infinite');

        expect(result).toBe('marquee');
      });

      it('should return "marquee" for infinite translateX animation', () => {
        const result = classifier.inferCategory('slide-text', '.ticker', ['transform'], 'infinite');

        expect(result).toBe('marquee');
      });

      it('should return "marquee" for carousel/slider infinite animation', () => {
        const result = classifier.inferCategory('carousel-slide', '.slider', ['transform'], 'infinite');

        expect(result).toBe('marquee');
      });
    });

    describe('video_overlay category', () => {
      it('should return "video_overlay" for video-overlay animation name', () => {
        const result = classifier.inferCategory('video-overlay', '.element', ['opacity'], 1);

        expect(result).toBe('video_overlay');
      });

      it('should return "video_overlay" for video selector', () => {
        const result = classifier.inferCategory('fade', '.video-container', ['opacity'], 1);

        expect(result).toBe('video_overlay');
      });

      it('should return "video_overlay" for media-overlay selector', () => {
        const result = classifier.inferCategory('fade', '.media-overlay', ['opacity'], 1);

        expect(result).toBe('video_overlay');
      });

      it('should return "video_overlay" for player-controls selector', () => {
        const result = classifier.inferCategory('fade', '.player-controls', ['opacity'], 1);

        expect(result).toBe('video_overlay');
      });
    });

    describe('parallax category', () => {
      it('should return "parallax" for parallax animation name', () => {
        const result = classifier.inferCategory('parallax', '.element', ['transform'], 1);

        expect(result).toBe('parallax');
      });

      it('should return "parallax" for parallax-bg animation name', () => {
        const result = classifier.inferCategory('parallax-bg', '.element', ['transform'], 1);

        expect(result).toBe('parallax');
      });

      it('should return "parallax" for depth-effect animation name', () => {
        const result = classifier.inferCategory('depth-effect', '.element', ['transform'], 1);

        expect(result).toBe('parallax');
      });

      it('should return "parallax" for parallax selector', () => {
        const result = classifier.inferCategory('translate', '.parallax-layer', ['transform'], 1);

        expect(result).toBe('parallax');
      });
    });

    describe('reveal category', () => {
      it('should return "reveal" for reveal animation name', () => {
        const result = classifier.inferCategory('reveal', '.element', ['opacity', 'transform'], 1);

        expect(result).toBe('reveal');
      });

      it('should return "reveal" for fadeIn animation name', () => {
        const result = classifier.inferCategory('fadeIn', '.element', ['opacity'], 1);

        expect(result).toBe('reveal');
      });

      it('should return "reveal" for slideUp animation name', () => {
        const result = classifier.inferCategory('slideUp', '.element', ['transform', 'opacity'], 1);

        expect(result).toBe('reveal');
      });

      it('should return "reveal" for animateIn animation name', () => {
        const result = classifier.inferCategory('animateIn', '.element', ['opacity', 'transform'], 1);

        expect(result).toBe('reveal');
      });

      it('should return "reveal" for text-reveal animation name', () => {
        const result = classifier.inferCategory('text-reveal', '.element', ['opacity', 'transform'], 1);

        expect(result).toBe('reveal');
      });
    });

    describe('morphing category', () => {
      it('should return "morphing" for morph animation name', () => {
        const result = classifier.inferCategory('morph', '.element', ['d', 'path'], 1);

        expect(result).toBe('morphing');
      });

      it('should return "morphing" for shape-morph animation name', () => {
        const result = classifier.inferCategory('shape-morph', '.element', [], 1);

        expect(result).toBe('morphing');
      });

      it('should return "morphing" for path-animation animation name', () => {
        const result = classifier.inferCategory('path-animation', '.element', ['d'], 1);

        expect(result).toBe('morphing');
      });

      it('should return "morphing" for svg path with d property', () => {
        const result = classifier.inferCategory('animate', '.svg-path', ['d'], 1);

        expect(result).toBe('morphing');
      });

      it('should return "morphing" for blob animation name', () => {
        const result = classifier.inferCategory('blob-morph', '.element', [], 1);

        expect(result).toBe('morphing');
      });
    });

    describe('background_animation category', () => {
      it('should return "background_animation" for background-shift animation name', () => {
        const result = classifier.inferCategory('background-shift', '.element', ['background-position'], 1);

        expect(result).toBe('background_animation');
      });

      it('should return "background_animation" for gradient-move animation name', () => {
        const result = classifier.inferCategory('gradient-move', '.element', ['background'], 1);

        expect(result).toBe('background_animation');
      });

      it('should return "background_animation" for background-position property', () => {
        const result = classifier.inferCategory('move', '.bg-animated', ['background-position'], 1);

        expect(result).toBe('background_animation');
      });
    });

    describe('typing_animation category', () => {
      it('should return "typing_animation" for typing animation name', () => {
        const result = classifier.inferCategory('typing', '.element', ['width'], 1);

        expect(result).toBe('typing_animation');
      });

      it('should return "typing_animation" for typewriter animation name', () => {
        const result = classifier.inferCategory('typewriter', '.element', ['width'], 1);

        expect(result).toBe('typing_animation');
      });

      it('should return "typing_animation" for cursor-blink animation name', () => {
        const result = classifier.inferCategory('cursor-blink', '.cursor', ['opacity'], 'infinite');

        expect(result).toBe('typing_animation');
      });
    });

    describe('unknown category', () => {
      it('should return "unknown" for unrecognized patterns', () => {
        const result = classifier.inferCategory('custom-animation', '.custom-class', [], 1);

        expect(result).toBe('unknown');
      });

      it('should return "unknown" for empty name and selector', () => {
        const result = classifier.inferCategory('', '', [], 1);

        expect(result).toBe('unknown');
      });
    });

    describe('priority handling', () => {
      it('should prioritize hover_effect for :hover selector even with infinite iterations', () => {
        // v6.x: hover_effect (Priority 5) is checked before loading_state (Priority 3)
        // but loading_state requires specific name hints (spin, rotate, etc.)
        // 'hover-effect' matches hover_effect pattern due to :hover selector
        const result = classifier.inferCategory('hover-effect', '.button:hover', [], 'infinite');

        expect(result).toBe('hover_effect');
      });

      it('should prioritize hover_effect over scroll_trigger for :hover selector', () => {
        // :hover selector should be hover_effect even with fade-in name
        const result = classifier.inferCategory('fade-in', '.button:hover', [], 1);

        expect(result).toBe('hover_effect');
      });
    });
  });

  // =====================================================
  // Type Export Tests
  // =====================================================

  describe('Type Exports', () => {
    it('should have TriggerType type available', () => {
      // Type assertion to ensure the type exists
      const trigger: TriggerType = 'hover';
      expect(['hover', 'focus', 'click', 'scroll', 'intersection', 'load', 'unknown']).toContain(
        trigger
      );
    });

    it('should have MotionCategory type available', () => {
      // Type assertion to ensure the type exists
      const category: MotionCategory = 'hover_effect';
      expect([
        'scroll_trigger',
        'hover_effect',
        'page_transition',
        'loading_state',
        'navigation',
        'feedback',
        'micro_interaction',
        'attention_grabber',
        'entrance',
        'exit',
        // New categories added in v0.1.0
        'marquee',
        'video_overlay',
        'parallax',
        'reveal',
        'morphing',
        'background_animation',
        'typing_animation',
        'unknown',
      ]).toContain(category);
    });
  });
});
