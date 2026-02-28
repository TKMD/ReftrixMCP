// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProjectContextAnalyzer Service
 *
 * Analyzes project patterns (design tokens, hooks, CSS classes)
 * and calculates adaptability scores for layout.search results.
 *
 * Purpose:
 * - Detect existing project patterns (STYLES, DESIGN_TOKENS constants)
 * - Identify custom hooks (useScrollAnimation, useGsap)
 * - Parse CSS framework patterns (TailwindCSS 4.1 @theme variables)
 * - Calculate adaptability scores for search results
 * - Generate integration hints for easier adoption
 *
 * Security (MCP-SEC-02):
 * - Path validation to prevent directory traversal attacks
 * - Allowed workspace restriction for local file access
 * - Blocked path patterns for sensitive directories
 * - Symlink escape detection
 *
 * @module services/project-context-analyzer
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDevelopment, logger } from '../utils/logger';
import {
  validateProjectPath,
  validateFilePath,
  matchesBlockedFilePattern,
  type PathValidationResult,
} from '../utils/path-security';

// =====================================================
// Types
// =====================================================

/**
 * Design token style definition
 */
export interface StyleDefinition {
  name: string;
  type: 'const' | 'export-const' | 'let' | 'var';
  colors: Record<string, string>;
  file: string;
}

/**
 * Project design tokens
 */
export interface DesignTokens {
  styles: StyleDefinition[];
}

/**
 * Hook definition
 */
export interface HookDefinition {
  name: string;
  file: string;
  exports: string[];
}

/**
 * Theme variable definition
 */
export interface ThemeVariable {
  name: string;
  value: string;
}

/**
 * Animation definition
 */
export interface AnimationDefinition {
  name: string;
  type: 'keyframes' | 'animation' | 'transition';
}

/**
 * Project patterns detected from codebase
 */
export interface ProjectPatterns {
  designTokens: DesignTokens;
  hooks: HookDefinition[];
  cssFramework: string;
  themeVariables: ThemeVariable[];
  animations: AnimationDefinition[];
  utilityClasses: string[];
}

/**
 * Integration hints for adapting search results
 */
export interface IntegrationHints {
  suggested_hooks: string[];
  color_mapping: Record<string, string>;
  existing_animations: string[];
}

/**
 * Adaptability calculation result
 */
export interface AdaptabilityResult {
  score: number;
  integration_hints: IntegrationHints;
}

/**
 * Options for project context analysis
 */
export interface ProjectContextOptions {
  enabled: boolean;
  projectPath?: string;
  designTokensPath?: string;
}

// =====================================================
// Constants
// =====================================================

/** File extensions to scan */
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css'];

/** Directories to skip */
const SKIP_DIRECTORIES = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

/** Regex patterns */
const PATTERNS = {
  // Match const STYLES = { ... } or const DESIGN_TOKENS = { ... }
  constStyles: /(?:export\s+)?const\s+(STYLES|DESIGN_TOKENS|THEME|COLORS|TOKENS)\s*=\s*\{/gi,
  // Match color values (hex, rgb, rgba, oklch, hsl)
  colorValue: /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|oklch\([^)]+\)|hsla?\([^)]+\)/g,
  // Match color properties in object
  colorProperty: /['"]?([\w.-]+)['"]?\s*:\s*['"]?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|oklch\([^)]+\)|hsla?\([^)]+\))['"]?/g,
  // Match hook exports
  hookExport: /export\s+(?:function|const)\s+(use[A-Z]\w*)/g,
  // Match @theme CSS variables
  themeVariable: /--[\w-]+:\s*[^;]+;/g,
  // Match @keyframes
  keyframes: /@keyframes\s+([\w-]+)\s*\{/g,
  // Match CSS class definitions
  cssClass: /\.([\w-]+)\s*\{/g,
  // Match TailwindCSS v4 import
  tailwindImport: /@import\s+["']tailwindcss["']/,
  // Match scroll animation patterns in HTML
  scrollAnimation: /data-(?:scroll|animation)|animate-on-scroll|scroll-triggered|will-animate/i,
  // Match 3D/complex animation patterns
  complexAnimation: /perspective|rotateX|rotateY|rotateZ|transform3d|timeline|gsap/i,
  // Match style attribute colors
  styleColor: /(?:color|background(?:-color)?|border(?:-color)?)\s*:\s*([^;'"]+)/gi,
};

// =====================================================
// ProjectContextAnalyzer
// =====================================================

/**
 * Service for analyzing project patterns and calculating adaptability scores
 */
export class ProjectContextAnalyzer {
  private patternCache: Map<string, ProjectPatterns> = new Map();

  /**
   * Detect project patterns from the codebase
   *
   * Security (MCP-SEC-02):
   * - Path validation before scanning
   * - Allowed workspace restriction
   * - Directory traversal prevention
   *
   * @param projectPath - Root path to scan
   * @returns Detected project patterns
   * @throws Error if path validation fails (security violation)
   */
  async detectProjectPatterns(projectPath: string): Promise<ProjectPatterns> {
    // Check cache first (use normalized path for cache key)
    const cached = this.patternCache.get(projectPath);
    if (cached) {
      return cached;
    }

    const patterns: ProjectPatterns = {
      designTokens: { styles: [] },
      hooks: [],
      cssFramework: 'unknown',
      themeVariables: [],
      animations: [],
      utilityClasses: [],
    };

    // MCP-SEC-02: Validate project path before scanning
    const validationResult: PathValidationResult = validateProjectPath(projectPath);
    if (!validationResult.isValid) {
      if (isDevelopment()) {
        logger.warn('[ProjectContextAnalyzer] Path validation failed', {
          projectPath,
          errorCode: validationResult.error?.code,
          errorMessage: validationResult.error?.message,
        });
      }
      // Return empty patterns instead of scanning disallowed paths
      // This is a security measure to prevent unauthorized filesystem access
      return patterns;
    }

    // Use validated/normalized path for scanning
    const normalizedPath = validationResult.normalizedPath!;

    if (!fs.existsSync(normalizedPath)) {
      if (isDevelopment()) {
        logger.warn('[ProjectContextAnalyzer] Project path does not exist', { projectPath: normalizedPath });
      }
      return patterns;
    }

    try {
      // Scan for patterns using validated path
      await this.scanDirectory(normalizedPath, patterns, 0, normalizedPath);

      // Cache results with original path as key
      this.patternCache.set(projectPath, patterns);

      if (isDevelopment()) {
        logger.info('[ProjectContextAnalyzer] Patterns detected', {
          styles: patterns.designTokens.styles.length,
          hooks: patterns.hooks.length,
          cssFramework: patterns.cssFramework,
          themeVariables: patterns.themeVariables.length,
          animations: patterns.animations.length,
          utilityClasses: patterns.utilityClasses.length,
        });
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[ProjectContextAnalyzer] Error detecting patterns', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return patterns;
  }

  /**
   * Scan directory for patterns
   *
   * Security (MCP-SEC-02):
   * - Validates each file path before reading
   * - Blocks access to sensitive file patterns
   * - Ensures paths stay within workspace boundary
   *
   * @param dirPath - Directory to scan
   * @param patterns - Patterns object to populate
   * @param depth - Current recursion depth (max: 5)
   * @param workspacePath - Root workspace path for validation
   */
  private async scanDirectory(
    dirPath: string,
    patterns: ProjectPatterns,
    depth = 0,
    workspacePath?: string
  ): Promise<void> {
    // Limit recursion depth
    if (depth > 5) return;

    // MCP-SEC-02: Ensure workspace path is set
    const validatedWorkspace = workspacePath ?? dirPath;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryName: string = typeof entry === 'string' ? entry : entry.name ?? '';

        // Skip hidden and excluded directories
        if (SKIP_DIRECTORIES.includes(entryName) || entryName.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(dirPath, entryName);

        // MCP-SEC-02: Validate file path is within workspace
        if (!validateFilePath(fullPath, validatedWorkspace)) {
          if (isDevelopment()) {
            logger.warn('[ProjectContextAnalyzer] Skipping path outside workspace', {
              path: fullPath,
              workspace: validatedWorkspace,
            });
          }
          continue;
        }

        // MCP-SEC-02: Check for blocked file patterns
        if (matchesBlockedFilePattern(entryName)) {
          if (isDevelopment()) {
            logger.debug('[ProjectContextAnalyzer] Skipping blocked file pattern', {
              filename: entryName,
            });
          }
          continue;
        }

        try {
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            await this.scanDirectory(fullPath, patterns, depth + 1, validatedWorkspace);
          } else if (stat.isFile()) {
            const ext = path.extname(entryName);
            if (SCANNABLE_EXTENSIONS.includes(ext)) {
              this.analyzeFile(fullPath, entryName, patterns);
            }
          }
        } catch {
          // Skip files we can't access
          continue;
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  /**
   * Analyze a single file for patterns
   */
  private analyzeFile(filePath: string, fileName: string, patterns: ProjectPatterns): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(fileName);

      if (ext === '.css') {
        this.analyzeCssFile(content, patterns);
      } else {
        this.analyzeJsFile(content, fileName, patterns);
      }
    } catch {
      // Skip files we can't read
    }
  }

  /**
   * Analyze JavaScript/TypeScript file
   */
  private analyzeJsFile(content: string, fileName: string, patterns: ProjectPatterns): void {
    // Detect style constants (STYLES, DESIGN_TOKENS, etc.)
    let match: RegExpExecArray | null;
    PATTERNS.constStyles.lastIndex = 0;

    while ((match = PATTERNS.constStyles.exec(content)) !== null) {
      const constantName = match[1] ?? '';
      const isExport = match[0].startsWith('export');

      // Extract colors from the constant
      const colors = this.extractColors(content, match.index);

      patterns.designTokens.styles.push({
        name: constantName,
        type: isExport ? 'export-const' : 'const',
        colors,
        file: fileName,
      });
    }

    // Detect hooks
    PATTERNS.hookExport.lastIndex = 0;
    while ((match = PATTERNS.hookExport.exec(content)) !== null) {
      const hookName = match[1] ?? '';
      if (!hookName) continue;

      // Check if this hook already exists
      const existingHook = patterns.hooks.find((h) => h.name === hookName);
      if (!existingHook) {
        patterns.hooks.push({
          name: hookName,
          file: fileName,
          exports: [hookName],
        });
      }
    }
  }

  /**
   * Analyze CSS file
   */
  private analyzeCssFile(content: string, patterns: ProjectPatterns): void {
    // Detect TailwindCSS v4
    if (PATTERNS.tailwindImport.test(content)) {
      patterns.cssFramework = 'tailwindcss-v4';
    }

    // Extract @theme variables
    const themeMatch = content.match(/@theme\s*\{([^}]+)\}/s);
    if (themeMatch && themeMatch[1]) {
      const themeContent = themeMatch[1];

      const varMatches = themeContent.match(/--[\w-]+:\s*[^;]+/g);
      if (varMatches) {
        for (const vm of varMatches) {
          const parts = vm.split(':');
          const name = parts[0];
          const value = parts.slice(1).join(':').trim();
          if (name) {
            patterns.themeVariables.push({ name: name.trim(), value });
          }
        }
      }
    }

    // Extract @keyframes
    let keyframeMatch: RegExpExecArray | null;
    PATTERNS.keyframes.lastIndex = 0;
    while ((keyframeMatch = PATTERNS.keyframes.exec(content)) !== null) {
      const animName = keyframeMatch[1];
      if (animName) {
        patterns.animations.push({
          name: animName,
          type: 'keyframes',
        });
      }
    }

    // Extract utility classes
    let classMatch: RegExpExecArray | null;
    PATTERNS.cssClass.lastIndex = 0;
    while ((classMatch = PATTERNS.cssClass.exec(content)) !== null) {
      const className = classMatch[1];
      // Only include meaningful utility classes
      if (className && className.length > 2 && !className.startsWith('_')) {
        patterns.utilityClasses.push(className);
      }
    }
  }

  /**
   * Extract color values from content starting at a position
   */
  private extractColors(content: string, startIndex: number): Record<string, string> {
    const colors: Record<string, string> = {};

    // Find the object content (basic brace matching)
    let braceCount = 0;
    let objectStart = -1;
    let objectEnd = -1;

    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') {
        if (objectStart === -1) objectStart = i;
        braceCount++;
      } else if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0 && objectStart !== -1) {
          objectEnd = i;
          break;
        }
      }
    }

    if (objectStart === -1 || objectEnd === -1) return colors;

    const objectContent = content.slice(objectStart, objectEnd + 1);

    // Extract color properties
    let match: RegExpExecArray | null;
    PATTERNS.colorProperty.lastIndex = 0;
    while ((match = PATTERNS.colorProperty.exec(objectContent)) !== null) {
      const propertyPath = match[1];
      const colorValue = match[2];
      if (propertyPath && colorValue) {
        colors[propertyPath] = colorValue;
      }
    }

    return colors;
  }

  /**
   * Calculate adaptability score for HTML against project patterns
   *
   * @param html - HTML snippet to analyze
   * @param patterns - Detected project patterns
   * @returns Adaptability result with score and hints
   */
  calculateAdaptabilityScore(html: string, patterns: ProjectPatterns): AdaptabilityResult {
    if (!html || html.trim().length === 0) {
      return {
        score: 0,
        integration_hints: {
          suggested_hooks: [],
          color_mapping: {},
          existing_animations: [],
        },
      };
    }

    let score = 0;
    const maxScore = 100;

    // 1. Color compatibility (40 points max)
    const colorScore = this.calculateColorCompatibility(html, patterns);
    score += colorScore * 0.4;

    // 2. Animation compatibility (30 points max)
    const animationScore = this.calculateAnimationCompatibility(html, patterns);
    score += animationScore * 0.3;

    // 3. Framework compatibility (20 points max)
    const frameworkScore = this.calculateFrameworkCompatibility(html, patterns);
    score += frameworkScore * 0.2;

    // 4. Utility class compatibility (10 points max)
    const utilityScore = this.calculateUtilityCompatibility(html, patterns);
    score += utilityScore * 0.1;

    // Generate integration hints
    const integration_hints = this.generateIntegrationHints(html, patterns);

    // Ensure score is within bounds
    score = Math.max(0, Math.min(maxScore, Math.round(score)));

    return {
      score,
      integration_hints,
    };
  }

  /**
   * Calculate color compatibility score
   */
  private calculateColorCompatibility(html: string, patterns: ProjectPatterns): number {
    const htmlColors = this.extractHtmlColors(html);
    if (htmlColors.length === 0) return 50; // Neutral if no colors

    const projectColors = this.getAllProjectColors(patterns);
    if (projectColors.length === 0) return 50; // Neutral if no project colors

    let matchCount = 0;
    for (const htmlColor of htmlColors) {
      if (this.findSimilarColor(htmlColor, projectColors)) {
        matchCount++;
      }
    }

    return (matchCount / htmlColors.length) * 100;
  }

  /**
   * Extract colors from HTML
   */
  private extractHtmlColors(html: string): string[] {
    const colors: string[] = [];
    let match: RegExpExecArray | null;

    PATTERNS.styleColor.lastIndex = 0;
    while ((match = PATTERNS.styleColor.exec(html)) !== null) {
      const colorValue = match[1];
      if (colorValue) {
        // Extract actual color value (hex, rgb, etc.)
        const colorMatch = colorValue.trim().match(PATTERNS.colorValue);
        if (colorMatch && colorMatch[0]) {
          colors.push(colorMatch[0].toLowerCase());
        }
      }
    }

    // Also check for inline color values in class attributes might reference
    const hexColors = html.match(/#[0-9a-fA-F]{3,8}/g);
    if (hexColors) {
      colors.push(...hexColors.map((c) => c.toLowerCase()));
    }

    return [...new Set(colors)];
  }

  /**
   * Get all project colors
   */
  private getAllProjectColors(patterns: ProjectPatterns): string[] {
    const colors: string[] = [];

    // From design tokens
    for (const style of patterns.designTokens.styles) {
      colors.push(...Object.values(style.colors).map((c) => c.toLowerCase()));
    }

    // From theme variables (extract color values)
    for (const variable of patterns.themeVariables) {
      if (variable.name.includes('color')) {
        const match = variable.value.match(PATTERNS.colorValue);
        if (match) {
          colors.push(match[0].toLowerCase());
        }
      }
    }

    return [...new Set(colors)];
  }

  /**
   * Find similar color in project colors
   */
  private findSimilarColor(color: string, projectColors: string[]): string | null {
    // Exact match
    const normalized = color.toLowerCase();
    if (projectColors.includes(normalized)) {
      return normalized;
    }

    // Convert to RGB for comparison if hex
    if (normalized.startsWith('#')) {
      const rgb = this.hexToRgb(normalized);
      if (rgb) {
        for (const pc of projectColors) {
          if (pc.startsWith('#')) {
            const pcRgb = this.hexToRgb(pc);
            if (pcRgb && this.colorDistance(rgb, pcRgb) < 30) {
              return pc;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Convert hex to RGB
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result || !result[1] || !result[2] || !result[3]) {
      // Try 3-digit hex
      const short = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex);
      if (!short || !short[1] || !short[2] || !short[3]) return null;
      return {
        r: parseInt(short[1] + short[1], 16),
        g: parseInt(short[2] + short[2], 16),
        b: parseInt(short[3] + short[3], 16),
      };
    }
    return {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    };
  }

  /**
   * Calculate Euclidean distance between two colors
   */
  private colorDistance(
    c1: { r: number; g: number; b: number },
    c2: { r: number; g: number; b: number }
  ): number {
    return Math.sqrt(
      Math.pow(c1.r - c2.r, 2) +
        Math.pow(c1.g - c2.g, 2) +
        Math.pow(c1.b - c2.b, 2)
    );
  }

  /**
   * Calculate animation compatibility score
   */
  private calculateAnimationCompatibility(html: string, patterns: ProjectPatterns): number {
    const hasScrollAnimation = PATTERNS.scrollAnimation.test(html);
    const hasComplexAnimation = PATTERNS.complexAnimation.test(html);

    // Check if project has corresponding hooks
    const hasScrollHook = patterns.hooks.some((h) =>
      h.name.toLowerCase().includes('scroll') || h.name.toLowerCase().includes('animation')
    );
    const hasGsapHook = patterns.hooks.some((h) =>
      h.name.toLowerCase().includes('gsap') || h.name.toLowerCase().includes('timeline')
    );

    let score = 50; // Base score

    if (hasScrollAnimation && hasScrollHook) score += 25;
    if (hasComplexAnimation && hasGsapHook) score += 25;
    if (!hasScrollAnimation && !hasComplexAnimation) score += 10; // Simple HTML is more adaptable

    return Math.min(100, score);
  }

  /**
   * Calculate framework compatibility score
   */
  private calculateFrameworkCompatibility(html: string, patterns: ProjectPatterns): number {
    // Check for TailwindCSS classes in HTML
    const hasTailwindClasses = /class="[^"]*\b(flex|grid|p-|m-|w-|h-|text-|bg-|border-)/i.test(html);

    if (patterns.cssFramework === 'tailwindcss-v4') {
      return hasTailwindClasses ? 100 : 60;
    }

    // If no specific framework, inline styles are neutral
    return 50;
  }

  /**
   * Calculate utility class compatibility score
   */
  private calculateUtilityCompatibility(html: string, patterns: ProjectPatterns): number {
    if (patterns.utilityClasses.length === 0) return 50;

    const htmlClasses = html.match(/class="([^"]*)"/g);
    if (!htmlClasses) return 50;

    let matchCount = 0;
    let totalClasses = 0;

    for (const classAttr of htmlClasses) {
      const classes = classAttr.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) || [];
      for (const cls of classes) {
        if (cls) {
          totalClasses++;
          if (patterns.utilityClasses.includes(cls)) {
            matchCount++;
          }
        }
      }
    }

    if (totalClasses === 0) return 50;
    return (matchCount / totalClasses) * 100;
  }

  /**
   * Generate integration hints for HTML against project patterns
   */
  generateIntegrationHints(html: string, patterns: ProjectPatterns): IntegrationHints {
    const hints: IntegrationHints = {
      suggested_hooks: [],
      color_mapping: {},
      existing_animations: [],
    };

    // Suggest hooks based on HTML patterns
    if (PATTERNS.scrollAnimation.test(html)) {
      const scrollHook = patterns.hooks.find((h) =>
        h.name.toLowerCase().includes('scroll') || h.name === 'useScrollAnimation'
      );
      if (scrollHook) {
        hints.suggested_hooks.push(scrollHook.name);
      }
    }

    if (PATTERNS.complexAnimation.test(html)) {
      const gsapHook = patterns.hooks.find((h) =>
        h.name.toLowerCase().includes('gsap') || h.name === 'useGsap'
      );
      if (gsapHook) {
        hints.suggested_hooks.push(gsapHook.name);
      }
    }

    // Map colors
    const htmlColors = this.extractHtmlColors(html);
    for (const color of htmlColors) {
      const mappedToken = this.mapColorToToken(color, patterns);
      if (mappedToken) {
        hints.color_mapping[color] = mappedToken;
      }
    }

    // Find existing animations that could be reused
    const htmlAnimations = this.extractAnimationNames(html);
    for (const anim of htmlAnimations) {
      const existing = patterns.animations.find((a) =>
        a.name.toLowerCase().includes(anim.toLowerCase()) ||
        anim.toLowerCase().includes(a.name.toLowerCase())
      );
      if (existing) {
        hints.existing_animations.push(existing.name);
      }
    }

    // Deduplicate
    hints.suggested_hooks = [...new Set(hints.suggested_hooks)];
    hints.existing_animations = [...new Set(hints.existing_animations)];

    return hints;
  }

  /**
   * Map a color to project token
   */
  private mapColorToToken(color: string, patterns: ProjectPatterns): string | null {
    const normalized = color.toLowerCase();

    // Check design tokens
    for (const style of patterns.designTokens.styles) {
      for (const [path, value] of Object.entries(style.colors)) {
        if (value.toLowerCase() === normalized) {
          return `${style.name}.${path}`;
        }

        // Check similar colors
        if (normalized.startsWith('#') && value.startsWith('#')) {
          const rgb1 = this.hexToRgb(normalized);
          const rgb2 = this.hexToRgb(value);
          if (rgb1 && rgb2 && this.colorDistance(rgb1, rgb2) < 20) {
            return `${style.name}.${path}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract animation names from HTML
   */
  private extractAnimationNames(html: string): string[] {
    const names: string[] = [];

    // From animation property
    const animMatch = html.match(/animation:\s*([\w-]+)/gi);
    if (animMatch) {
      for (const m of animMatch) {
        const name = m.replace(/animation:\s*/i, '').split(/\s/)[0];
        if (name) names.push(name);
      }
    }

    // From class names containing animation keywords
    const classMatch = html.match(/class="[^"]*animate[^"]*"/gi);
    if (classMatch) {
      for (const m of classMatch) {
        const classes = m.match(/animate[-\w]+/gi);
        if (classes) {
          names.push(...classes.map((c) => c.replace(/^animate-?/i, '')));
        }
      }
    }

    return [...new Set(names.filter((n) => n.length > 0))];
  }

  /**
   * Analyze with options (convenience method)
   */
  async analyzeWithOptions(
    projectPath: string,
    html: string,
    options: ProjectContextOptions
  ): Promise<AdaptabilityResult | null> {
    if (!options.enabled) {
      return null;
    }

    const scanPath = options.projectPath || projectPath;

    // If custom designTokensPath, scan that first
    let patterns = await this.detectProjectPatterns(scanPath);

    if (options.designTokensPath && fs.existsSync(options.designTokensPath)) {
      const tokenPatterns = await this.detectProjectPatterns(options.designTokensPath);
      // Merge token patterns
      patterns = {
        ...patterns,
        designTokens: {
          styles: [...patterns.designTokens.styles, ...tokenPatterns.designTokens.styles],
        },
      };
    }

    return this.calculateAdaptabilityScore(html, patterns);
  }

  /**
   * Clear pattern cache
   */
  clearCache(): void {
    this.patternCache.clear();
  }
}

// =====================================================
// Singleton Instance
// =====================================================

let instance: ProjectContextAnalyzer | null = null;

/**
 * Get ProjectContextAnalyzer instance (singleton)
 */
export function getProjectContextAnalyzer(): ProjectContextAnalyzer {
  if (!instance) {
    instance = new ProjectContextAnalyzer();
  }
  return instance;
}

/**
 * Reset ProjectContextAnalyzer instance
 */
export function resetProjectContextAnalyzer(): void {
  if (instance) {
    instance.clearCache();
  }
  instance = null;
}

export default ProjectContextAnalyzer;
