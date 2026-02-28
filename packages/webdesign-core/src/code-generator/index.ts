// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CodeGenerator
 *
 * 検出されたセクションパターンからReact/HTML/CSSコードを生成する
 *
 * @module @reftrix/webdesign-core/code-generator
 */

import type {
  DetectedSection,
  SectionType,
} from '../types/section.types';
import type { LayoutInspectOutput } from '../text-representation';

// =========================================
// Types
// =========================================

/**
 * コード生成オプション
 */
export interface CodeGeneratorOptions {
  /** フレームワーク */
  framework: 'react' | 'nextjs' | 'html';
  /** スタイリング方式 */
  styling: 'tailwind' | 'css-modules' | 'styled-components' | 'vanilla';
  /** TypeScript出力 */
  typescript: boolean;
  /** アクセシビリティ対応 */
  accessibility: boolean;
  /** レスポンシブ対応 */
  responsive: boolean;
  /** ダークモード対応 */
  darkMode: boolean;
}

/**
 * 生成されたコード
 */
export interface GeneratedCode {
  /** メインコンポーネントコード */
  component: string;
  /** スタイルシート（CSS/SCSSなど） */
  styles?: string;
  /** TypeScript型定義 */
  types?: string;
  /** 必要なimport文 */
  imports: string[];
  /** 必要なnpm依存関係 */
  dependencies: string[];
}

// =========================================
// Constants
// =========================================

const DEFAULT_OPTIONS: CodeGeneratorOptions = {
  framework: 'react',
  styling: 'tailwind',
  typescript: true,
  accessibility: true,
  responsive: true,
  darkMode: false,
};

/**
 * セクションタイプからコンポーネント名へのマッピング
 */
const SECTION_COMPONENT_NAMES: Record<SectionType, string> = {
  hero: 'HeroSection',
  navigation: 'Navigation',
  feature: 'FeatureSection',
  cta: 'CTASection',
  testimonial: 'TestimonialSection',
  pricing: 'PricingSection',
  footer: 'Footer',
  about: 'AboutSection',
  contact: 'ContactSection',
  gallery: 'GallerySection',
  unknown: 'Section',
  // 拡張タイプ
  partners: 'PartnersSection',
  portfolio: 'PortfolioSection',
  team: 'TeamSection',
  stories: 'StoriesSection',
  research: 'ResearchSection',
  subscribe: 'SubscribeSection',
  stats: 'StatsSection',
  faq: 'FAQSection',
};

/**
 * セクションタイプからHTMLタグへのマッピング
 */
const SECTION_HTML_TAGS: Record<SectionType, string> = {
  hero: 'section',
  navigation: 'nav',
  feature: 'section',
  cta: 'section',
  testimonial: 'section',
  pricing: 'section',
  footer: 'footer',
  about: 'section',
  contact: 'section',
  gallery: 'section',
  unknown: 'section',
  // 拡張タイプ
  partners: 'section',
  portfolio: 'section',
  team: 'section',
  stories: 'section',
  research: 'section',
  subscribe: 'section',
  stats: 'section',
  faq: 'section',
};

// =========================================
// Helper Functions
// =========================================

/**
 * テキストをエスケープする
 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSX用にテキストをエスケープする
 */
function escapeJsxText(text: string): string {
  return text
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * BEM形式のクラス名を生成
 */
function toBemClass(block: string, element?: string, modifier?: string): string {
  let className = block;
  if (element) {
    className += `__${element}`;
  }
  if (modifier) {
    className += `--${modifier}`;
  }
  return className;
}

// =========================================
// CodeGenerator Class
// =========================================

/**
 * CodeGeneratorクラス
 *
 * DetectedSectionからコードを生成する
 */
export class CodeGenerator {
  private options: CodeGeneratorOptions;

  constructor(options?: Partial<CodeGeneratorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CodeGenerator] Initialized with options:', this.options);
    }
  }

  /**
   * オプションを取得
   */
  getOptions(): CodeGeneratorOptions {
    return { ...this.options };
  }

  /**
   * 単一セクションからコードを生成
   */
  generate(section: DetectedSection, inspectResult?: LayoutInspectOutput): GeneratedCode {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CodeGenerator] Generating code for section:', section.type);
    }

    switch (this.options.framework) {
      case 'nextjs':
        return this.generateNextJS(section, inspectResult);
      case 'html':
        return this.generateHTML(section, inspectResult);
      case 'react':
      default:
        return this.generateReact(section, inspectResult);
    }
  }

  /**
   * 複数セクションからコードを一括生成
   */
  generateBatch(sections: DetectedSection[], inspectResult?: LayoutInspectOutput): GeneratedCode[] {
    if (sections.length === 0) {
      return [];
    }

    return sections.map((section, index) => {
      const result = this.generate(section, inspectResult);
      // ユニークなコンポーネント名を付与（同一タイプが複数ある場合）
      if (index > 0) {
        const componentName = SECTION_COMPONENT_NAMES[section.type];
        result.component = result.component.replace(
          new RegExp(componentName, 'g'),
          `${componentName}${index + 1}`
        );
      }
      return result;
    });
  }

  // =========================================
  // React Generation
  // =========================================

  private generateReact(section: DetectedSection, inspectResult?: LayoutInspectOutput): GeneratedCode {
    const componentName = SECTION_COMPONENT_NAMES[section.type];
    const imports: string[] = ["import React from 'react'"];
    const dependencies: string[] = ['react'];

    if (this.options.styling === 'tailwind') {
      dependencies.push('tailwindcss');
    }
    if (this.options.typescript) {
      dependencies.push('typescript');
    }

    // スタイリング
    let styles: string | undefined;
    let componentCode: string;

    switch (this.options.styling) {
      case 'styled-components':
        imports.push("import styled from 'styled-components'");
        dependencies.push('styled-components');
        componentCode = this.generateStyledComponent(section, componentName, inspectResult);
        break;
      case 'css-modules':
        imports.push(`import styles from './${componentName}.module.css'`);
        styles = this.generateCSSModules(section, componentName, inspectResult);
        componentCode = this.generateCSSModulesComponent(section, componentName, inspectResult);
        break;
      case 'vanilla':
        styles = this.generateVanillaCSS(section, componentName, inspectResult);
        componentCode = this.generateVanillaReactComponent(section, componentName, inspectResult);
        break;
      case 'tailwind':
      default:
        componentCode = this.generateTailwindComponent(section, componentName, inspectResult);
        break;
    }

    // TypeScript型定義
    let types: string | undefined;
    if (this.options.typescript) {
      types = this.generateTypeDefinitions(section, componentName);
    }

    const result: GeneratedCode = {
      component: componentCode,
      imports,
      dependencies,
    };

    if (styles) {
      result.styles = styles;
    }
    if (types) {
      result.types = types;
    }

    return result;
  }

  // =========================================
  // Next.js Generation
  // =========================================

  private generateNextJS(section: DetectedSection, inspectResult?: LayoutInspectOutput): GeneratedCode {
    const componentName = SECTION_COMPONENT_NAMES[section.type];
    const hasInteractivity = section.content.buttons.length > 0 || section.type === 'navigation';

    const imports: string[] = ["import React from 'react'"];
    const dependencies: string[] = ['react', 'next'];

    // Next.js Image/Link imports
    if (section.content.images.length > 0) {
      imports.push("import Image from 'next/image'");
    }
    if (section.content.links.length > 0 || section.type === 'navigation') {
      imports.push("import Link from 'next/link'");
    }

    if (this.options.styling === 'tailwind') {
      dependencies.push('tailwindcss');
    }
    if (this.options.typescript) {
      dependencies.push('typescript');
    }

    let styles: string | undefined;
    let componentCode: string;

    // スタイリングに応じた生成
    switch (this.options.styling) {
      case 'css-modules':
        imports.push(`import styles from './${componentName}.module.css'`);
        styles = this.generateCSSModules(section, componentName, inspectResult);
        componentCode = this.generateNextJSCSSModulesComponent(section, componentName, hasInteractivity, inspectResult);
        break;
      case 'styled-components':
        imports.push("import styled from 'styled-components'");
        dependencies.push('styled-components');
        componentCode = this.generateNextJSStyledComponent(section, componentName, hasInteractivity, inspectResult);
        break;
      case 'vanilla':
        styles = this.generateVanillaCSS(section, componentName, inspectResult);
        componentCode = this.generateNextJSVanillaComponent(section, componentName, hasInteractivity, inspectResult);
        break;
      case 'tailwind':
      default:
        componentCode = this.generateNextJSTailwindComponent(section, componentName, hasInteractivity, inspectResult);
        break;
    }

    // TypeScript型定義
    let types: string | undefined;
    if (this.options.typescript) {
      types = this.generateTypeDefinitions(section, componentName);
    }

    const result: GeneratedCode = {
      component: componentCode,
      imports,
      dependencies,
    };

    if (styles) {
      result.styles = styles;
    }
    if (types) {
      result.types = types;
    }

    return result;
  }

  // =========================================
  // HTML Generation
  // =========================================

  private generateHTML(section: DetectedSection, inspectResult?: LayoutInspectOutput): GeneratedCode {
    const componentName = SECTION_COMPONENT_NAMES[section.type];
    const blockName = section.type === 'unknown' ? 'section' : section.type;
    const htmlTag = SECTION_HTML_TAGS[section.type];
    const dependencies: string[] = [];

    let styles = '';
    if (this.options.styling === 'vanilla') {
      styles = this.generateVanillaCSS(section, componentName, inspectResult);
    }

    const ariaAttrs = this.options.accessibility ? this.generateAriaAttributes(section) : '';

    let content = '';

    // Build HTML content
    if (section.type === 'hero') {
      content = this.generateHeroHTML(section, blockName);
    } else if (section.type === 'navigation') {
      content = this.generateNavigationHTML(section, blockName);
    } else if (section.type === 'feature') {
      content = this.generateFeatureHTML(section, blockName);
    } else if (section.type === 'cta') {
      content = this.generateCtaHTML(section, blockName);
    } else if (section.type === 'footer') {
      content = this.generateFooterHTML(section, blockName);
    } else if (section.type === 'testimonial') {
      content = this.generateTestimonialHTML(section, blockName);
    } else if (section.type === 'pricing') {
      content = this.generatePricingHTML(section, blockName);
    } else if (section.type === 'about') {
      content = this.generateAboutHTML(section, blockName);
    } else if (section.type === 'contact') {
      content = this.generateContactHTML(section, blockName);
    } else if (section.type === 'gallery') {
      content = this.generateGalleryHTML(section, blockName);
    } else {
      content = this.generateGenericHTML(section, blockName);
    }

    const component = `<${htmlTag} class="${blockName}"${ariaAttrs}>
${content}
</${htmlTag}>`;

    const result: GeneratedCode = {
      component,
      imports: [],
      dependencies,
    };

    if (styles) {
      result.styles = styles;
    }

    return result;
  }

  // =========================================
  // Tailwind Component Generation
  // =========================================

  private generateTailwindComponent(
    section: DetectedSection,
    componentName: string,
    inspectResult?: LayoutInspectOutput
  ): string {
    const { type } = section;
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';

    // Generate appropriate content based on section type
    let jsx = '';

    switch (type) {
      case 'hero':
        jsx = this.generateHeroJSX(section, 'tailwind', inspectResult);
        break;
      case 'navigation':
        jsx = this.generateNavigationJSX(section, 'tailwind', inspectResult);
        break;
      case 'feature':
        jsx = this.generateFeatureJSX(section, 'tailwind', inspectResult);
        break;
      case 'cta':
        jsx = this.generateCtaJSX(section, 'tailwind', inspectResult);
        break;
      case 'footer':
        jsx = this.generateFooterJSX(section, 'tailwind', inspectResult);
        break;
      case 'testimonial':
        jsx = this.generateTestimonialJSX(section, 'tailwind', inspectResult);
        break;
      case 'pricing':
        jsx = this.generatePricingJSX(section, 'tailwind', inspectResult);
        break;
      case 'about':
        jsx = this.generateAboutJSX(section, 'tailwind', inspectResult);
        break;
      case 'contact':
        jsx = this.generateContactJSX(section, 'tailwind', inspectResult);
        break;
      case 'gallery':
        jsx = this.generateGalleryJSX(section, 'tailwind', inspectResult);
        break;
      default:
        jsx = this.generateGenericJSX(section, 'tailwind', inspectResult);
    }

    // Wrap with memo for certain section types
    const shouldMemo = ['feature', 'gallery', 'testimonial', 'pricing'].includes(type);

    if (shouldMemo) {
      return `export const ${componentName}${propsType} = React.memo(function ${componentName}() {
  return (
${jsx}
  );
});`;
    }

    return `export const ${componentName}${propsType} = () => {
  return (
${jsx}
  );
};`;
  }

  // =========================================
  // Section-specific JSX Generators (Tailwind)
  // =========================================

  private generateHeroJSX(section: DetectedSection, _styling: string, inspectResult?: LayoutInspectOutput): string {
    const { content, style } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const primaryButton = content.buttons.find(b => b.type === 'primary');
    const secondaryButton = content.buttons.find(b => b.type === 'secondary');
    const image = content.images[0];

    const bgClass = style.hasGradient ? 'bg-gradient-to-r from-indigo-600 to-purple-600' : 'bg-gray-900';
    const maxWidth = inspectResult?.grid?.maxWidth ? `max-w-[${inspectResult.grid.maxWidth}px]` : 'max-w-7xl';

    let imageJSX = '';
    if (image) {
      imageJSX = `
        <img
          src="${escapeText(image.src)}"
          alt="${escapeText(image.alt || '')}"
          className="w-full h-auto object-cover rounded-lg shadow-xl"
        />`;
    }

    const responsiveClasses = this.options.responsive ? 'px-4 md:px-6 lg:px-8' : 'px-6';
    const responsiveText = this.options.responsive ? 'text-4xl md:text-5xl lg:text-6xl' : 'text-5xl';

    return `    <section className="min-h-screen ${bgClass} text-white flex items-center">
      <div className="${maxWidth} mx-auto ${responsiveClasses} py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            ${heading ? `<h1 className="${responsiveText} font-bold mb-6">${escapeJsxText(heading.text)}</h1>` : ''}
            ${paragraph ? `<p className="text-xl text-gray-300 mb-8">${escapeJsxText(paragraph)}</p>` : ''}
            <div className="flex gap-4">
              ${primaryButton ? `<button className="bg-white text-gray-900 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition">${escapeJsxText(primaryButton.text)}</button>` : ''}
              ${secondaryButton ? `<button className="border border-white px-8 py-3 rounded-lg font-semibold hover:bg-white/10 transition">${escapeJsxText(secondaryButton.text)}</button>` : ''}
            </div>
          </div>
          ${image ? `<div>${imageJSX}</div>` : ''}
        </div>
      </div>
    </section>`;
  }

  private generateNavigationJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const logo = content.images[0];
    const links = content.links;

    const ariaLabel = this.options.accessibility ? ' aria-label="Main navigation"' : '';
    const skipLink = this.options.accessibility ? `
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-white text-gray-900 px-4 py-2 rounded">
          Skip to main content
        </a>` : '';

    const mobileMenu = this.options.responsive ? `
          <button className="md:hidden" aria-label="Toggle menu">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>` : '';

    const responsiveNav = this.options.responsive ? 'hidden md:flex' : 'flex';

    return `    <nav className="bg-white shadow-sm sticky top-0 z-50"${ariaLabel}>${skipLink}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            ${logo ? `<img src="${escapeText(logo.src)}" alt="${escapeText(logo.alt || 'logo')}" className="h-8 w-auto" />` : '<span className="font-bold text-xl">Logo</span>'}
          </div>
          <div className="${responsiveNav} items-center gap-8">
            ${links.map(link => `<a href="${escapeText(link.href)}" className="text-gray-600 hover:text-gray-900 transition">${escapeJsxText(link.text)}</a>`).join('\n            ')}
          </div>${mobileMenu}
        </div>
      </div>
    </nav>`;
  }

  private generateFeatureJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const mainHeading = content.headings[0];
    const subHeadings = content.headings.slice(1);
    const paragraphs = content.paragraphs;
    const images = content.images;

    const gridCols = this.options.responsive ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' : 'grid-cols-3';

    const features = subHeadings.map((heading, index) => {
      const image = images[index];
      const description = paragraphs[index] || '';
      return `
          <div className="text-center p-6">
            ${image ? `<img src="${escapeText(image.src)}" alt="${escapeText(image.alt || '')}" className="w-16 h-16 mx-auto mb-4" />` : ''}
            <h3 className="text-xl font-semibold mb-2">${escapeJsxText(heading.text)}</h3>
            ${description ? `<p className="text-gray-600">${escapeJsxText(description)}</p>` : ''}
          </div>`;
    }).join('');

    return `    <section className="py-20 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        ${mainHeading ? `<h2 className="text-3xl md:text-4xl font-bold text-center mb-12">${escapeJsxText(mainHeading.text)}</h2>` : ''}
        <div className="grid ${gridCols} gap-8">${features}
        </div>
      </div>
    </section>`;
  }

  private generateCtaJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content, style } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const primaryButton = content.buttons.find(b => b.type === 'primary');
    const secondaryButton = content.buttons.find(b => b.type === 'secondary');

    const bgClass = style.hasGradient ? 'bg-gradient-to-r from-indigo-600 to-purple-600' : 'bg-indigo-600';

    return `    <section className="${bgClass} py-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        ${heading ? `<h2 className="text-3xl md:text-4xl font-bold text-white mb-4">${escapeJsxText(heading.text)}</h2>` : ''}
        ${paragraph ? `<p className="text-xl text-indigo-100 mb-8">${escapeJsxText(paragraph)}</p>` : ''}
        <div className="flex justify-center gap-4">
          ${primaryButton ? `<button className="bg-white text-indigo-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition">${escapeJsxText(primaryButton.text)}</button>` : ''}
          ${secondaryButton ? `<button className="border border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white/10 transition">${escapeJsxText(secondaryButton.text)}</button>` : ''}
        </div>
      </div>
    </section>`;
  }

  private generateFooterJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const headings = content.headings;
    const links = content.links;
    const copyright = content.paragraphs.find(p => p.includes('2024') || p.includes('(C)') || p.includes('copyright'));

    return `    <footer className="bg-gray-900 text-gray-300 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          ${headings.map((heading, idx) => `
          <div>
            <h4 className="text-white font-semibold mb-4">${escapeJsxText(heading.text)}</h4>
            <ul className="space-y-2">
              ${links.slice(idx * 2, idx * 2 + 2).map(link => `<li><a href="${escapeText(link.href)}" className="hover:text-white transition">${escapeJsxText(link.text)}</a></li>`).join('\n              ')}
            </ul>
          </div>`).join('')}
        </div>
        ${copyright ? `<div className="border-t border-gray-800 pt-8 text-center text-sm">${escapeJsxText(copyright)}</div>` : ''}
      </div>
    </footer>`;
  }

  private generateTestimonialJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const quotes = content.paragraphs;
    const avatars = content.images;

    return `    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        ${heading ? `<h2 className="text-3xl md:text-4xl font-bold text-center mb-12">${escapeJsxText(heading.text)}</h2>` : ''}
        <div className="grid md:grid-cols-2 gap-8">
          ${quotes.map((quote, idx) => {
            const avatar = avatars[idx];
            return `
          <div className="bg-gray-50 p-8 rounded-xl">
            <p className="text-lg text-gray-700 mb-6">${escapeJsxText(quote)}</p>
            ${avatar ? `<div className="flex items-center">
              <img src="${escapeText(avatar.src)}" alt="${escapeText(avatar.alt || '')}" className="w-12 h-12 rounded-full mr-4" />
              <span className="font-semibold">${escapeText(avatar.alt || '')}</span>
            </div>` : ''}
          </div>`;
          }).join('')}
        </div>
      </div>
    </section>`;
  }

  private generatePricingJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const plans = content.headings.slice(1);
    const prices = content.paragraphs;
    const buttons = content.buttons;

    return `    <section className="py-20 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        ${heading ? `<h2 className="text-3xl md:text-4xl font-bold text-center mb-12">${escapeJsxText(heading.text)}</h2>` : ''}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          ${plans.map((plan, idx) => {
            const price = prices[idx] || '';
            const button = buttons[idx];
            return `
          <div className="bg-white p-8 rounded-xl shadow-lg">
            <h3 className="text-2xl font-bold mb-4">${escapeJsxText(plan.text)}</h3>
            ${price ? `<p className="text-4xl font-bold text-indigo-600 mb-6">${escapeJsxText(price)}</p>` : ''}
            ${button ? `<button className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition">${escapeJsxText(button.text)}</button>` : ''}
          </div>`;
          }).join('')}
        </div>
      </div>
    </section>`;
  }

  private generateAboutJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const images = content.images;

    return `    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            ${heading ? `<h2 className="text-3xl md:text-4xl font-bold mb-6">${escapeJsxText(heading.text)}</h2>` : ''}
            ${paragraph ? `<p className="text-lg text-gray-600">${escapeJsxText(paragraph)}</p>` : ''}
          </div>
          <div className="grid grid-cols-2 gap-4">
            ${images.map(img => `<img src="${escapeText(img.src)}" alt="${escapeText(img.alt || '')}" className="rounded-lg shadow-lg" />`).join('\n            ')}
          </div>
        </div>
      </div>
    </section>`;
  }

  private generateContactJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraphs = content.paragraphs;
    const button = content.buttons[0];

    return `    <section className="py-20 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        ${heading ? `<h2 className="text-3xl md:text-4xl font-bold text-center mb-8">${escapeJsxText(heading.text)}</h2>` : ''}
        <div className="text-center mb-8">
          ${paragraphs.map(p => `<p className="text-gray-600">${escapeJsxText(p)}</p>`).join('\n          ')}
        </div>
        <form className="space-y-6">
          <input type="text" placeholder="Name" className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
          <input type="email" placeholder="Email" className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
          <textarea placeholder="Message" rows={4} className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"></textarea>
          ${button ? `<button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition">${escapeJsxText(button.text)}</button>` : ''}
        </form>
      </div>
    </section>`;
  }

  private generateGalleryJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const images = content.images;

    const gridCols = this.options.responsive ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4' : 'grid-cols-4';

    return `    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        ${heading ? `<h2 className="text-3xl md:text-4xl font-bold text-center mb-12">${escapeJsxText(heading.text)}</h2>` : ''}
        <div className="grid ${gridCols} gap-4">
          ${images.map(img => `<img src="${escapeText(img.src)}" alt="${escapeText(img.alt || '')}" className="w-full h-48 object-cover rounded-lg hover:opacity-90 transition" />`).join('\n          ')}
        </div>
      </div>
    </section>`;
  }

  private generateGenericJSX(section: DetectedSection, _styling: string, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraphs = content.paragraphs;

    return `    <section className="py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        ${heading ? `<h2 className="text-3xl font-bold mb-6">${escapeJsxText(heading.text)}</h2>` : ''}
        ${paragraphs.map(p => `<p className="text-gray-600 mb-4">${escapeJsxText(p)}</p>`).join('\n        ')}
      </div>
    </section>`;
  }

  // =========================================
  // CSS Modules Generation
  // =========================================

  private generateCSSModulesComponent(
    section: DetectedSection,
    componentName: string,
    inspectResult?: LayoutInspectOutput
  ): string {
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';

    const jsx = this.generateCSSModuleJSX(section, componentName, inspectResult);

    return `export const ${componentName}${propsType} = () => {
  return (
${jsx}
  );
};`;
  }

  private generateCSSModuleJSX(section: DetectedSection, _componentName: string, _inspectResult?: LayoutInspectOutput): string {
    const { type, content } = section;
    const htmlTag = SECTION_HTML_TAGS[type];
    const heading = content.headings[0];
    const button = content.buttons[0];

    return `    <${htmlTag} className={styles.container}>
      <div className={styles.wrapper}>
        ${heading ? `<h1 className={styles.heading}>${escapeJsxText(heading.text)}</h1>` : ''}
        ${button ? `<button className={styles.button}>${escapeJsxText(button.text)}</button>` : ''}
      </div>
    </${htmlTag}>`;
  }

  private generateCSSModules(section: DetectedSection, _componentName: string, inspectResult?: LayoutInspectOutput): string {
    const { style } = section;
    const fontFamily = inspectResult?.typography?.fonts[0]?.family || 'system-ui';

    let css = `.container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  background-color: ${style.backgroundColor || '#1a1a2e'};
  color: ${style.textColor || '#ffffff'};
}

.wrapper {
  max-width: 1280px;
  margin: 0 auto;
  padding: 5rem 1.5rem;
}

.heading {
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
  font-family: '${fontFamily}', sans-serif;
}

.button {
  background-color: #ffffff;
  color: #1a1a2e;
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}

.button:hover {
  background-color: #f3f4f6;
}`;

    if (this.options.responsive) {
      css += `

@media (min-width: 768px) {
  .heading {
    font-size: 4rem;
  }
}`;
    }

    if (this.options.darkMode) {
      css += `

@media (prefers-color-scheme: dark) {
  .container {
    background-color: #0f0f23;
  }
}`;
    }

    return css;
  }

  // =========================================
  // Styled Components Generation
  // =========================================

  private generateStyledComponent(
    section: DetectedSection,
    componentName: string,
    _inspectResult?: LayoutInspectOutput
  ): string {
    const { type, content, style } = section;
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';
    const htmlTag = SECTION_HTML_TAGS[type];

    const heading = content.headings[0];
    const button = content.buttons[0];
    const bgColor = style.backgroundColor || '#1a1a2e';
    const textColor = style.textColor || '#ffffff';

    return `const StyledSection = styled.${htmlTag}\`
  min-height: 100vh;
  display: flex;
  align-items: center;
  background-color: ${bgColor};
  color: ${textColor};
\`;

const Wrapper = styled.div\`
  max-width: 1280px;
  margin: 0 auto;
  padding: 5rem 1.5rem;
\`;

const Heading = styled.h1\`
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
\`;

const Button = styled.button\`
  background-color: #ffffff;
  color: ${bgColor};
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;

  &:hover {
    background-color: #f3f4f6;
  }
\`;

export const ${componentName}${propsType} = () => {
  return (
    <StyledSection>
      <Wrapper>
        ${heading ? `<Heading>${escapeJsxText(heading.text)}</Heading>` : ''}
        ${button ? `<Button>${escapeJsxText(button.text)}</Button>` : ''}
      </Wrapper>
    </StyledSection>
  );
};`;
  }

  // =========================================
  // Vanilla CSS Generation
  // =========================================

  private generateVanillaReactComponent(
    section: DetectedSection,
    componentName: string,
    _inspectResult?: LayoutInspectOutput
  ): string {
    const { type, content } = section;
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';
    const htmlTag = SECTION_HTML_TAGS[type];
    const blockName = type === 'unknown' ? 'section' : type;

    const heading = content.headings[0];
    const button = content.buttons[0];

    return `export const ${componentName}${propsType} = () => {
  return (
    <${htmlTag} className="${blockName}">
      <div className="${toBemClass(blockName, 'wrapper')}">
        ${heading ? `<h1 className="${toBemClass(blockName, 'heading')}">${escapeJsxText(heading.text)}</h1>` : ''}
        ${button ? `<button className="${toBemClass(blockName, 'button')}">${escapeJsxText(button.text)}</button>` : ''}
      </div>
    </${htmlTag}>
  );
};`;
  }

  private generateVanillaCSS(section: DetectedSection, _componentName: string, inspectResult?: LayoutInspectOutput): string {
    const { type, style } = section;
    const blockName = type === 'unknown' ? 'section' : type;
    const fontFamily = inspectResult?.typography?.fonts[0]?.family || 'Inter';

    let css = `:root {
  --${blockName}-bg: ${style.backgroundColor || '#1a1a2e'};
  --${blockName}-text: ${style.textColor || '#ffffff'};
  --${blockName}-accent: #4f46e5;
  --font-family: '${fontFamily}', system-ui, sans-serif;
}

.${blockName} {
  min-height: 100vh;
  display: flex;
  align-items: center;
  background-color: var(--${blockName}-bg);
  color: var(--${blockName}-text);
  font-family: var(--font-family);
}

.${toBemClass(blockName, 'wrapper')} {
  max-width: 1280px;
  margin: 0 auto;
  padding: 5rem 1.5rem;
}

.${toBemClass(blockName, 'heading')} {
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.${toBemClass(blockName, 'button')} {
  background-color: #ffffff;
  color: var(--${blockName}-bg);
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background-color 0.2s;
}

.${toBemClass(blockName, 'button')}:hover {
  background-color: #f3f4f6;
}`;

    if (this.options.responsive) {
      css += `

@media (min-width: 768px) {
  .${toBemClass(blockName, 'heading')} {
    font-size: 4rem;
  }
}

@media (min-width: 1024px) {
  .${toBemClass(blockName, 'heading')} {
    font-size: 5rem;
  }
}`;
    }

    if (this.options.darkMode) {
      css += `

@media (prefers-color-scheme: dark) {
  :root {
    --${blockName}-bg: #0f0f23;
  }
}`;
    }

    return css;
  }

  // =========================================
  // Next.js Component Generators
  // =========================================

  private generateNextJSTailwindComponent(
    section: DetectedSection,
    componentName: string,
    hasInteractivity: boolean,
    inspectResult?: LayoutInspectOutput
  ): string {
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';
    const useClientDirective = hasInteractivity ? "'use client'\n\n" : '';

    let jsx = '';

    switch (section.type) {
      case 'hero':
        jsx = this.generateNextJSHeroJSX(section, inspectResult);
        break;
      case 'navigation':
        jsx = this.generateNextJSNavigationJSX(section, inspectResult);
        break;
      default:
        jsx = this.generateHeroJSX(section, 'tailwind', inspectResult);
    }

    return `${useClientDirective}export const ${componentName}${propsType} = () => {
  return (
${jsx}
  );
};`;
  }

  private generateNextJSHeroJSX(section: DetectedSection, _inspectResult?: LayoutInspectOutput): string {
    const { content, style } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const primaryButton = content.buttons.find(b => b.type === 'primary');
    const image = content.images[0];

    const bgClass = style.hasGradient ? 'bg-gradient-to-r from-indigo-600 to-purple-600' : 'bg-gray-900';

    let imageJSX = '';
    if (image) {
      imageJSX = `
        <Image
          src="${escapeText(image.src)}"
          alt="${escapeText(image.alt || '')}"
          width={600}
          height={400}
          className="w-full h-auto object-cover rounded-lg shadow-xl"
          priority
        />`;
    }

    return `    <section className="min-h-screen ${bgClass} text-white flex items-center">
      <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            ${heading ? `<h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">${escapeJsxText(heading.text)}</h1>` : ''}
            ${paragraph ? `<p className="text-xl text-gray-300 mb-8">${escapeJsxText(paragraph)}</p>` : ''}
            ${primaryButton ? `<button className="bg-white text-gray-900 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition">${escapeJsxText(primaryButton.text)}</button>` : ''}
          </div>
          ${image ? `<div>${imageJSX}</div>` : ''}
        </div>
      </div>
    </section>`;
  }

  private generateNextJSNavigationJSX(section: DetectedSection, _inspectResult?: LayoutInspectOutput): string {
    const { content } = section;
    const logo = content.images[0];
    const links = content.links;

    const ariaLabel = this.options.accessibility ? ' aria-label="Main navigation"' : '';
    const skipLink = this.options.accessibility ? `
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-white text-gray-900 px-4 py-2 rounded">
          Skip to main content
        </a>` : '';

    const mobileMenu = this.options.responsive ? `
          <button className="md:hidden" aria-label="Toggle menu">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>` : '';

    return `    <nav className="bg-white shadow-sm sticky top-0 z-50"${ariaLabel}>${skipLink}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            ${logo ? `<Image src="${escapeText(logo.src)}" alt="${escapeText(logo.alt || 'logo')}" width={32} height={32} className="h-8 w-auto" />` : '<span className="font-bold text-xl">Logo</span>'}
          </div>
          <div className="hidden md:flex items-center gap-8">
            ${links.map(link => `<Link href="${escapeText(link.href)}" className="text-gray-600 hover:text-gray-900 transition">${escapeJsxText(link.text)}</Link>`).join('\n            ')}
          </div>${mobileMenu}
        </div>
      </div>
    </nav>`;
  }

  private generateNextJSCSSModulesComponent(
    section: DetectedSection,
    componentName: string,
    hasInteractivity: boolean,
    inspectResult?: LayoutInspectOutput
  ): string {
    const propsType = this.options.typescript ? `: React.FC<${componentName}Props>` : '';
    const useClientDirective = hasInteractivity ? "'use client'\n\n" : '';

    const jsx = this.generateCSSModuleJSX(section, componentName, inspectResult);

    return `${useClientDirective}export const ${componentName}${propsType} = () => {
  return (
${jsx}
  );
};`;
  }

  private generateNextJSStyledComponent(
    section: DetectedSection,
    componentName: string,
    _hasInteractivity: boolean,
    inspectResult?: LayoutInspectOutput
  ): string {
    const useClientDirective = "'use client'\n\n";
    return useClientDirective + this.generateStyledComponent(section, componentName, inspectResult);
  }

  private generateNextJSVanillaComponent(
    section: DetectedSection,
    componentName: string,
    hasInteractivity: boolean,
    inspectResult?: LayoutInspectOutput
  ): string {
    const useClientDirective = hasInteractivity ? "'use client'\n\n" : '';

    return useClientDirective + this.generateVanillaReactComponent(section, componentName, inspectResult);
  }

  // =========================================
  // HTML Section Generators
  // =========================================

  private generateHeroHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const button = content.buttons[0];
    const image = content.images[0];

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h1 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h1>` : ''}
    ${paragraph ? `<p class="${toBemClass(blockName, 'description')}">${escapeText(paragraph)}</p>` : ''}
    ${button ? `<button class="${toBemClass(blockName, 'button')}" type="button">${escapeText(button.text)}</button>` : ''}
    ${image ? `<img class="${toBemClass(blockName, 'image')}" src="${escapeText(image.src)}" alt="${escapeText(image.alt || '')}" />` : ''}
  </div>`;
  }

  private generateNavigationHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const logo = content.images[0];
    const links = content.links;

    const skipLink = this.options.accessibility ? `
    <a href="#main" class="${toBemClass(blockName, 'skip')}">Skip to main content</a>` : '';

    return `${skipLink}
  <div class="${toBemClass(blockName, 'wrapper')}">
    ${logo ? `<img class="${toBemClass(blockName, 'logo')}" src="${escapeText(logo.src)}" alt="${escapeText(logo.alt || 'logo')}" />` : ''}
    <ul class="${toBemClass(blockName, 'links')}" role="menubar">
      ${links.map(link => `<li role="none"><a href="${escapeText(link.href)}" class="${toBemClass(blockName, 'link')}" role="menuitem">${escapeText(link.text)}</a></li>`).join('\n      ')}
    </ul>
  </div>`;
  }

  private generateFeatureHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const mainHeading = content.headings[0];
    const subHeadings = content.headings.slice(1);
    const paragraphs = content.paragraphs;
    const images = content.images;

    const features = subHeadings.map((heading, idx) => {
      const image = images[idx];
      const description = paragraphs[idx] || '';
      return `
      <div class="${toBemClass(blockName, 'item')}">
        ${image ? `<img class="${toBemClass(blockName, 'icon')}" src="${escapeText(image.src)}" alt="${escapeText(image.alt || '')}" />` : ''}
        <h3 class="${toBemClass(blockName, 'item-title')}">${escapeText(heading.text)}</h3>
        ${description ? `<p class="${toBemClass(blockName, 'item-description')}">${escapeText(description)}</p>` : ''}
      </div>`;
    }).join('');

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${mainHeading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(mainHeading.text)}</h2>` : ''}
    <div class="${toBemClass(blockName, 'grid')}">${features}
    </div>
  </div>`;
  }

  private generateCtaHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const buttons = content.buttons;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    ${paragraph ? `<p class="${toBemClass(blockName, 'description')}">${escapeText(paragraph)}</p>` : ''}
    <div class="${toBemClass(blockName, 'buttons')}">
      ${buttons.map((btn) => `<button class="${toBemClass(blockName, 'button', btn.type)}" type="button">${escapeText(btn.text)}</button>`).join('\n      ')}
    </div>
  </div>`;
  }

  private generateFooterHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const headings = content.headings;
    const links = content.links;
    const copyright = content.paragraphs.find(p => p.includes('2024') || p.includes('(C)'));

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    <div class="${toBemClass(blockName, 'columns')}">
      ${headings.map((heading, idx) => `
      <div class="${toBemClass(blockName, 'column')}">
        <h4 class="${toBemClass(blockName, 'column-title')}">${escapeText(heading.text)}</h4>
        <ul class="${toBemClass(blockName, 'column-links')}">
          ${links.slice(idx * 2, idx * 2 + 2).map(link => `<li><a href="${escapeText(link.href)}">${escapeText(link.text)}</a></li>`).join('\n          ')}
        </ul>
      </div>`).join('')}
    </div>
    ${copyright ? `<div class="${toBemClass(blockName, 'copyright')}">${escapeText(copyright)}</div>` : ''}
  </div>`;
  }

  private generateTestimonialHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const quotes = content.paragraphs;
    const avatars = content.images;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    <div class="${toBemClass(blockName, 'grid')}">
      ${quotes.map((quote, idx) => {
        const avatar = avatars[idx];
        return `
      <div class="${toBemClass(blockName, 'item')}">
        <p class="${toBemClass(blockName, 'quote')}">${escapeText(quote)}</p>
        ${avatar ? `<div class="${toBemClass(blockName, 'author')}">
          <img class="${toBemClass(blockName, 'avatar')}" src="${escapeText(avatar.src)}" alt="${escapeText(avatar.alt || '')}" />
          <span class="${toBemClass(blockName, 'name')}">${escapeText(avatar.alt || '')}</span>
        </div>` : ''}
      </div>`;
      }).join('')}
    </div>
  </div>`;
  }

  private generatePricingHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const plans = content.headings.slice(1);
    const prices = content.paragraphs;
    const buttons = content.buttons;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    <div class="${toBemClass(blockName, 'grid')}">
      ${plans.map((plan, idx) => {
        const price = prices[idx] || '';
        const button = buttons[idx];
        return `
      <div class="${toBemClass(blockName, 'card')}">
        <h3 class="${toBemClass(blockName, 'plan-name')}">${escapeText(plan.text)}</h3>
        ${price ? `<p class="${toBemClass(blockName, 'price')}">${escapeText(price)}</p>` : ''}
        ${button ? `<button class="${toBemClass(blockName, 'button')}" type="button">${escapeText(button.text)}</button>` : ''}
      </div>`;
      }).join('')}
    </div>
  </div>`;
  }

  private generateAboutHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraph = content.paragraphs[0];
    const images = content.images;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    <div class="${toBemClass(blockName, 'content')}">
      ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
      ${paragraph ? `<p class="${toBemClass(blockName, 'description')}">${escapeText(paragraph)}</p>` : ''}
    </div>
    <div class="${toBemClass(blockName, 'images')}">
      ${images.map(img => `<img class="${toBemClass(blockName, 'image')}" src="${escapeText(img.src)}" alt="${escapeText(img.alt || '')}" />`).join('\n      ')}
    </div>
  </div>`;
  }

  private generateContactHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraphs = content.paragraphs;
    const button = content.buttons[0];

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    <div class="${toBemClass(blockName, 'info')}">
      ${paragraphs.map(p => `<p>${escapeText(p)}</p>`).join('\n      ')}
    </div>
    <form class="${toBemClass(blockName, 'form')}">
      <input type="text" placeholder="Name" class="${toBemClass(blockName, 'input')}" />
      <input type="email" placeholder="Email" class="${toBemClass(blockName, 'input')}" />
      <textarea placeholder="Message" class="${toBemClass(blockName, 'textarea')}" rows="4"></textarea>
      ${button ? `<button type="submit" class="${toBemClass(blockName, 'button')}">${escapeText(button.text)}</button>` : ''}
    </form>
  </div>`;
  }

  private generateGalleryHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const images = content.images;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    <div class="${toBemClass(blockName, 'grid')}">
      ${images.map(img => `<img class="${toBemClass(blockName, 'image')}" src="${escapeText(img.src)}" alt="${escapeText(img.alt || '')}" />`).join('\n      ')}
    </div>
  </div>`;
  }

  private generateGenericHTML(section: DetectedSection, blockName: string): string {
    const { content } = section;
    const heading = content.headings[0];
    const paragraphs = content.paragraphs;

    return `  <div class="${toBemClass(blockName, 'wrapper')}">
    ${heading ? `<h2 class="${toBemClass(blockName, 'heading')}">${escapeText(heading.text)}</h2>` : ''}
    ${paragraphs.map(p => `<p class="${toBemClass(blockName, 'text')}">${escapeText(p)}</p>`).join('\n    ')}
  </div>`;
  }

  // =========================================
  // ARIA Attributes
  // =========================================

  private generateAriaAttributes(section: DetectedSection): string {
    const attrs: string[] = [];

    switch (section.type) {
      case 'navigation':
        attrs.push('role="navigation"');
        attrs.push('aria-label="Main navigation"');
        break;
      case 'hero':
        attrs.push('role="banner"');
        break;
      case 'footer':
        attrs.push('role="contentinfo"');
        break;
      case 'cta':
        attrs.push('role="region"');
        attrs.push('aria-label="Call to action"');
        break;
      default:
        attrs.push('role="region"');
    }

    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  // =========================================
  // Type Definitions
  // =========================================

  private generateTypeDefinitions(section: DetectedSection, componentName: string): string {
    const { content, type } = section;

    let props = `export interface ${componentName}Props {
  /** Optional CSS class name */
  className?: string;`;

    // Add type-specific props
    if (content.headings.length > 0) {
      props += `
  /** Heading text override */
  title?: string;`;
    }

    if (content.paragraphs.length > 0) {
      props += `
  /** Description text override */
  description?: string;`;
    }

    if (content.buttons.length > 0) {
      props += `
  /** CTA button configuration */
  cta?: {
    text: string;
    href?: string;
    onClick?: () => void;
  };`;
    }

    if (content.images.length > 0) {
      props += `
  /** Image configuration */
  image?: {
    src: string;
    alt: string;
  };`;
    }

    if (type === 'navigation') {
      props += `
  /** Navigation links */
  links?: Array<{
    text: string;
    href: string;
  }>;`;
    }

    props += `
}`;

    return props;
  }
}
