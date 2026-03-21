// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter - プロンプト定数
 *
 * LlamaVisionAdapterで使用する全プロンプト文字列を提供します。
 *
 * @module vision-adapter/llama-vision.prompts
 */

// =============================================================================
// 基本プロンプト
// =============================================================================

/**
 * シンプルなJSON出力プロンプト（llama3.2-vision最適化）
 *
 * llama3.2-visionは複雑なプロンプトでは不完全なJSONを生成する傾向があるため、
 * シンプルな構造で確実にJSON出力を得る戦略を採用。
 */
export const DEFAULT_ANALYSIS_PROMPT = `You are a JSON generator. Your ONLY output must be valid JSON. No explanations, no markdown, no text before or after.

Look at this web page screenshot and analyze: {features_to_analyze}

Output this exact JSON structure:
{"layout":"grid-type","colors":["#hex1","#hex2","#hex3"],"mood":"dark-or-light","sections":["section1","section2"]}

JSON:`;

/**
 * セクション単位分析用プロンプト（llama3.2-vision最適化）
 *
 * 単一セクションのスクリーンショットに特化した分析プロンプト。
 * セクションタイプのヒントを活用してより正確な分析を行う。
 */
export const SECTION_ANALYSIS_PROMPT = `You are analyzing a single section extracted from a web page screenshot. Focus specifically on the visual characteristics of THIS section only.

Section type hint: {section_type}

Analyze the following aspects:
1. Layout structure (grid, columns, alignment)
2. Color scheme (dominant colors, contrast)
3. Whitespace usage (minimal/moderate/generous)
4. Visual hierarchy (typography scale, emphasis)
5. Key visual elements (icons, images, buttons)

Output a concise JSON:
{"layout":"description", "colors":["#hex1","#hex2"], "whitespace":"level", "hierarchy":"description", "elements":["item1","item2"]}

JSON:`;

// =============================================================================
// Reftrix専用プロンプト
// =============================================================================

/**
 * セクション境界検出プロンプト
 *
 * スクリーンショットからセクション境界を視覚的に検出。
 * HTML解析では検出できないビジュアルセパレーターを認識。
 *
 * @version 0.1.0 - 18種類のセクションタイプをサポート
 */
export const SECTION_BOUNDARY_DETECTION_PROMPT = `You are a web design section detector. Your ONLY output must be valid JSON. No explanations.

Look at this web page screenshot and identify ALL distinct visual sections.

Look for visual separators:
- Background color changes
- Large whitespace gaps
- Horizontal dividers/lines
- Full-width images/videos
- Different content patterns (grid vs text)

For each section found, output:
1. type: One of the following 18 section types:
   - hero: Hero/banner section at top
   - feature: Features/benefits grid
   - cta: Call-to-action with prominent button
   - testimonial: Customer reviews/quotes
   - pricing: Pricing plans/tables
   - footer: Page footer
   - navigation: Navigation bar/menu
   - gallery: Image gallery/showcase
   - about: About us/company info
   - contact: Contact form/info
   - partners: Partner/client logos
   - portfolio: Portfolio/work samples
   - team: Team members/staff
   - stories: Case studies/success stories
   - research: Research/insights/reports
   - subscribe: Newsletter signup
   - stats: Statistics/numbers/metrics
   - faq: FAQ accordion/questions
   - content: Generic content section
   - unknown: Cannot determine type
2. cues: visual indicators that define this section
3. position: top/upper/middle/lower/bottom

Output JSON array only:
{"sections":[{"type":"hero","cues":["dark background","large heading","centered content"],"position":"top"},{"type":"feature","cues":["3-column grid","icons","white background"],"position":"middle"}]}

JSON:`;

/**
 * モーション/インタラクション検出プロンプト
 *
 * スクリーンショットからアニメーション対象要素を推定。
 * CSS/JS静的解析の補完として使用。
 */
export const MOTION_DETECTION_PROMPT = `You are a web animation detector. Your ONLY output must be valid JSON. No explanations.

Analyze this web page screenshot for potential animation and interaction elements.

Look for:
- Buttons and CTAs (hover effects expected)
- Cards with shadows (hover lift effects)
- Navigation menus (dropdown animations)
- Hero sections (entrance animations likely)
- Scroll indicators (scroll animations)
- Floating elements (parallax candidates)
- Image galleries (transition effects)
- Form inputs (focus animations)

Output JSON:
{"likely_animations":[{"element":"hero heading","type":"fade-in","confidence":0.8},{"element":"feature cards","type":"hover-scale","confidence":0.9}],"interactive_elements":["primary cta button","navigation menu","search input"],"scroll_triggers":["feature section","testimonial carousel"]}

JSON:`;

/**
 * AIクリシェ検出プロンプト
 *
 * AI生成デザインの典型的パターンを検出。
 * quality.evaluateのOriginality評価に活用。
 */
export const AI_CLICHE_DETECTION_PROMPT = `You are an AI design cliche detector. Your ONLY output must be valid JSON. No explanations.

Detect AI-generated design clichés in this web page screenshot.

Common AI design clichés to look for:
- Abstract gradient spheres/orbs
- Generic 3D isometric illustrations
- Meaningless geometric patterns
- Over-saturated purple/blue gradients
- Stock-looking AI-generated people
- Floating UI elements without context
- Generic "hero with laptop" imagery
- Overly symmetrical layouts

Output JSON:
{"cliches_detected":[{"type":"gradient_orbs","location":"hero background","severity":"high"},{"type":"generic_isometric","location":"feature section","severity":"medium"}],"originality_score":65,"assessment":"moderate-ai-influence","suggestions":["Replace gradient orbs with brand-specific visuals","Use authentic photography instead of AI illustrations"]}

Types: gradient_orbs, generic_isometric, meaningless_patterns, oversaturated_gradients, ai_generated_people, floating_ui, generic_hero, symmetrical_layout, other
Severity: low, medium, high
Assessment: highly-original, mostly-original, moderate-ai-influence, heavy-ai-influence

JSON:`;

/**
 * ブランドトーン分析プロンプト
 *
 * デザインの視覚的トーンとブランドパーソナリティを分析。
 * 品質評価のContextuality軸に活用。
 */
export const BRAND_TONE_ANALYSIS_PROMPT = `You are a brand tone analyzer. Your ONLY output must be valid JSON. No explanations.

Analyze the visual tone and brand personality of this web design.

Evaluate on these dimensions:
1. professionalism: minimal/moderate/bold
2. warmth: cold/neutral/warm
3. modernity: classic/contemporary/futuristic
4. energy: calm/balanced/dynamic
5. target_audience: enterprise/startup/creative/consumer

Look for indicators:
- Color temperature (cool vs warm)
- Shape language (sharp vs rounded)
- Imagery style (photography vs illustration)
- Layout density (spacious vs compact)

Output JSON:
{"professionalism":"moderate","warmth":"warm","modernity":"contemporary","energy":"balanced","target_audience":"startup","indicators":["rounded corners","warm accent colors","generous whitespace","lifestyle photography"]}

JSON:`;

// =============================================================================
// Phase 2: Enhanced Mood & Brand Tone Prompts
// =============================================================================

/**
 * Enhanced mood and brand tone analysis prompt
 *
 * Combines mood detection and brand tone analysis in a single request.
 * Optionally includes Phase 1 deterministic color context for improved accuracy.
 */
export const ENHANCED_MOOD_BRAND_TONE_PROMPT = `You are a web design mood and brand tone analyzer. Your ONLY output must be valid JSON. No explanations.

Analyze this web design screenshot for mood and brand personality.

MOOD TYPES (choose primary and optionally secondary):
- professional: Clean, business-like, corporate feel
- playful: Fun, whimsical, casual
- minimal: Simple, clean, lots of whitespace
- bold: Strong visual impact, dramatic
- elegant: Sophisticated, refined, upscale
- modern: Contemporary, cutting-edge
- classic: Timeless, traditional
- energetic: Dynamic, vibrant, active
- calm: Peaceful, serene, relaxed
- luxurious: Premium, high-end, exclusive

BRAND TONE TYPES (choose primary and optionally secondary):
- corporate: Professional, formal, business-focused
- friendly: Approachable, warm, inviting
- luxury: Premium, exclusive, high-end
- tech-forward: Innovative, digital-first
- creative: Artistic, imaginative
- trustworthy: Reliable, dependable
- innovative: Forward-thinking, pioneering
- traditional: Established, conventional

{color_context_section}

Analyze and output JSON:
{"mood":{"primary":"minimal","secondary":"modern","confidence":0.85,"indicators":["generous whitespace","clean typography","neutral colors"]},"brand_tone":{"primary":"tech-forward","secondary":"trustworthy","confidence":0.8,"professionalism":"moderate","warmth":"neutral","modernity":"contemporary","energy":"balanced","target_audience":"startup","indicators":["modern sans-serif fonts","tech imagery","blue accent colors"]}}

JSON:`;

/**
 * Color context section template for enhanced prompt
 */
export const COLOR_CONTEXT_SECTION_TEMPLATE = `
DETERMINISTIC COLOR ANALYSIS (use this as reference):
- Dominant colors: {dominant_colors}
- Theme: {theme} (confidence: {theme_confidence})
- Background: {background_color}
- Content density: {density} (0=sparse, 1=dense)
- Whitespace ratio: {whitespace_ratio}

Use this color data to inform your mood and brand tone analysis.`;
