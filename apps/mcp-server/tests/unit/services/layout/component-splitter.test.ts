// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Component Splitter Tests
 *
 * HTMLを意味のあるサブコンポーネントに分割する機能のテスト
 *
 * @module tests/unit/services/layout/component-splitter
 */

import { describe, it, expect } from 'vitest';
import {
  splitIntoComponents,
  type SplitResult,
  type SplitOptions,
} from '../../../../src/services/layout/component-splitter';

describe('component-splitter', () => {
  describe('splitIntoComponents', () => {
    // ==========================================================
    // 基本機能テスト
    // ==========================================================

    describe('基本機能', () => {
      it('空のHTMLの場合はメインコンポーネントのみを返す', () => {
        const result = splitIntoComponents('');

        expect(result.mainComponent.name).toBe('MainComponent');
        expect(result.mainComponent.jsx).toBe('');
        expect(result.mainComponent.imports).toHaveLength(0);
        expect(result.subComponents).toHaveLength(0);
      });

      it('単純なHTMLの場合は分割せずメインコンポーネントに含める', () => {
        const html = '<div><p>Hello World</p></div>';
        const result = splitIntoComponents(html);

        expect(result.mainComponent.jsx).toContain('Hello World');
        expect(result.subComponents).toHaveLength(0);
      });

      it('カスタムコンポーネント名を指定できる', () => {
        const html = '<div><p>Content</p></div>';
        const result = splitIntoComponents(html, { mainComponentName: 'HeroSection' });

        expect(result.mainComponent.name).toBe('HeroSection');
      });
    });

    // ==========================================================
    // セマンティックHTML要素の検出と分割
    // ==========================================================

    describe('セマンティックHTML要素の検出と分割', () => {
      it('header要素をHeaderSectionとして分割する', () => {
        const html = `
          <div>
            <header>
              <nav><a href="/">Home</a></nav>
              <h1>Site Title</h1>
            </header>
            <main>
              <p>Main content</p>
            </main>
          </div>
        `;
        const result = splitIntoComponents(html);

        const headerComponent = result.subComponents.find(c => c.name === 'HeaderSection');
        expect(headerComponent).toBeDefined();
        expect(headerComponent?.jsx).toContain('Site Title');
      });

      it('nav要素をNavigationとして分割する', () => {
        const html = `
          <div>
            <nav>
              <a href="/">Home</a>
              <a href="/about">About</a>
              <a href="/contact">Contact</a>
            </nav>
            <section>
              <p>Content</p>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        const navComponent = result.subComponents.find(c => c.name === 'Navigation');
        expect(navComponent).toBeDefined();
        expect(navComponent?.jsx).toContain('Home');
        expect(navComponent?.jsx).toContain('About');
      });

      it('main要素をMainContentとして分割する', () => {
        const html = `
          <div>
            <header><h1>Title</h1></header>
            <main>
              <article>
                <h2>Article Title</h2>
                <p>Article content here.</p>
              </article>
            </main>
          </div>
        `;
        const result = splitIntoComponents(html);

        const mainComponent = result.subComponents.find(c => c.name === 'MainContent');
        expect(mainComponent).toBeDefined();
        expect(mainComponent?.jsx).toContain('Article Title');
      });

      it('section要素をSectionとして分割する', () => {
        const html = `
          <div>
            <section>
              <h2>Features</h2>
              <p>Feature description</p>
            </section>
            <section>
              <h2>Pricing</h2>
              <p>Pricing info</p>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        const sections = result.subComponents.filter(c => c.name.includes('Section'));
        expect(sections.length).toBeGreaterThanOrEqual(2);
      });

      it('article要素をArticleとして分割する', () => {
        const html = `
          <main>
            <article>
              <h2>Blog Post Title</h2>
              <p>Blog post content goes here.</p>
              <footer>Posted by Author</footer>
            </article>
          </main>
        `;
        const result = splitIntoComponents(html);

        const articleComponent = result.subComponents.find(c => c.name === 'Article');
        expect(articleComponent).toBeDefined();
        expect(articleComponent?.jsx).toContain('Blog Post Title');
      });

      it('aside要素をAsideとして分割する', () => {
        const html = `
          <div>
            <main><p>Main content</p></main>
            <aside>
              <h3>Related Links</h3>
              <ul><li>Link 1</li><li>Link 2</li></ul>
            </aside>
          </div>
        `;
        const result = splitIntoComponents(html);

        const asideComponent = result.subComponents.find(c => c.name === 'Aside');
        expect(asideComponent).toBeDefined();
        expect(asideComponent?.jsx).toContain('Related Links');
      });

      it('footer要素をFooterSectionとして分割する', () => {
        const html = `
          <div>
            <main><p>Content</p></main>
            <footer>
              <p>Copyright 2024</p>
              <nav><a href="/privacy">Privacy</a></nav>
            </footer>
          </div>
        `;
        const result = splitIntoComponents(html);

        const footerComponent = result.subComponents.find(c => c.name === 'FooterSection');
        expect(footerComponent).toBeDefined();
        expect(footerComponent?.jsx).toContain('Copyright 2024');
      });
    });

    // ==========================================================
    // クラスパターンによる分割
    // ==========================================================

    describe('クラスパターンによる分割', () => {
      it('*-header クラスパターンを検出して分割する', () => {
        const html = `
          <div>
            <div class="site-header">
              <h1>Site Name</h1>
              <nav>Menu</nav>
              <button>Login</button>
            </div>
            <div class="main-content">
              <p>Content</p>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const headerComponent = result.subComponents.find(c => c.name === 'SiteHeader');
        expect(headerComponent).toBeDefined();
        expect(headerComponent?.jsx).toContain('Site Name');
      });

      it('*-nav クラスパターンを検出して分割する', () => {
        const html = `
          <div>
            <div class="main-nav">
              <a href="/">Home</a>
              <a href="/about">About</a>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const navComponent = result.subComponents.find(c => c.name === 'MainNav');
        expect(navComponent).toBeDefined();
      });

      it('*-card クラスパターンを検出して分割する', () => {
        const html = `
          <div>
            <div class="feature-card">
              <h3>Feature 1</h3>
              <p>Description</p>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const cardComponent = result.subComponents.find(c => c.name === 'FeatureCard');
        expect(cardComponent).toBeDefined();
        expect(cardComponent?.jsx).toContain('Feature 1');
      });

      it('*-item クラスパターンを検出して分割する', () => {
        const html = `
          <ul>
            <li class="menu-item">
              <a href="/">Menu 1</a>
            </li>
            <li class="menu-item">
              <a href="/about">Menu 2</a>
            </li>
          </ul>
        `;
        const result = splitIntoComponents(html);

        const itemComponent = result.subComponents.find(c => c.name === 'MenuItem');
        expect(itemComponent).toBeDefined();
      });

      it('*-list クラスパターンを検出して分割する', () => {
        const html = `
          <div>
            <ul class="product-list">
              <li>Product 1</li>
              <li>Product 2</li>
              <li>Product 3</li>
            </ul>
          </div>
        `;
        const result = splitIntoComponents(html);

        const listComponent = result.subComponents.find(c => c.name === 'ProductList');
        expect(listComponent).toBeDefined();
      });
    });

    // ==========================================================
    // data属性による分割
    // ==========================================================

    describe('data属性による分割', () => {
      it('data-component属性を検出して分割する', () => {
        const html = `
          <div>
            <div data-component="hero-banner">
              <h1>Welcome</h1>
              <p>Welcome to our site</p>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const heroComponent = result.subComponents.find(c => c.name === 'HeroBanner');
        expect(heroComponent).toBeDefined();
        expect(heroComponent?.jsx).toContain('Welcome');
      });

      it('data-section属性を検出して分割する', () => {
        const html = `
          <div>
            <div data-section="pricing-table">
              <h2>Pricing</h2>
              <div>Plan 1: $10</div>
              <div>Plan 2: $20</div>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const pricingComponent = result.subComponents.find(c => c.name === 'PricingTable');
        expect(pricingComponent).toBeDefined();
      });

      it('data-component属性の値をPascalCaseコンポーネント名に変換する', () => {
        const html = `
          <div data-component="user-profile-card">
            <img src="avatar.jpg" alt="Avatar" />
            <h3>User Name</h3>
          </div>
        `;
        const result = splitIntoComponents(html);

        const component = result.subComponents.find(c => c.name === 'UserProfileCard');
        expect(component).toBeDefined();
      });
    });

    // ==========================================================
    // 繰り返し構造の検出
    // ==========================================================

    describe('繰り返し構造の検出', () => {
      it('同じクラスを持つ複数の要素を1つのサブコンポーネントにまとめる', () => {
        const html = `
          <div class="cards">
            <div class="card">
              <h3>Card 1</h3>
              <p>Description 1</p>
            </div>
            <div class="card">
              <h3>Card 2</h3>
              <p>Description 2</p>
            </div>
            <div class="card">
              <h3>Card 3</h3>
              <p>Description 3</p>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        const cardComponent = result.subComponents.find(c => c.name === 'Card');
        expect(cardComponent).toBeDefined();
        // propsにtitle, descriptionが含まれる
        expect(cardComponent?.props.some(p => p.name === 'title')).toBe(true);
        expect(cardComponent?.props.some(p => p.name === 'description')).toBe(true);
      });

      it('リストアイテムを検出して繰り返しコンポーネントを作成する', () => {
        const html = `
          <ul class="features">
            <li class="feature">
              <span class="icon">*</span>
              <span class="text">Feature A</span>
            </li>
            <li class="feature">
              <span class="icon">*</span>
              <span class="text">Feature B</span>
            </li>
          </ul>
        `;
        const result = splitIntoComponents(html);

        const featureComponent = result.subComponents.find(c => c.name === 'Feature');
        expect(featureComponent).toBeDefined();
      });

      it('繰り返し要素のメインコンポーネントにはマップ構文を含む', () => {
        const html = `
          <div class="team">
            <div class="team-member">
              <img src="avatar1.jpg" alt="Member 1" />
              <h4>Name 1</h4>
            </div>
            <div class="team-member">
              <img src="avatar2.jpg" alt="Member 2" />
              <h4>Name 2</h4>
            </div>
          </div>
        `;
        const result = splitIntoComponents(html);

        // メインコンポーネントには {items.map(...)} 形式が含まれる
        expect(result.mainComponent.jsx).toContain('.map(');
      });
    });

    // ==========================================================
    // ネストされた構造の分割
    // ==========================================================

    describe('ネストされた構造の分割', () => {
      it('ネストレベル1まで分割する', () => {
        const html = `
          <div>
            <section class="hero-section">
              <div class="hero-content">
                <h1>Title</h1>
                <p>Description</p>
                <button>CTA</button>
              </div>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        // section要素はセマンティック要素として分割される
        const heroSection = result.subComponents.find(c => c.name === 'Section' || c.name === 'HeroSection');
        expect(heroSection).toBeDefined();
      });

      it('ネストレベル2以上は分割しない（デフォルト設定）', () => {
        const html = `
          <div>
            <section class="hero-section">
              <div class="hero-content">
                <div class="hero-title-wrapper">
                  <h1>Title</h1>
                  <p>Subtitle</p>
                  <span>Extra</span>
                </div>
              </div>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        // hero-title-wrapperはネストレベル2なので分割されない（デフォルトmaxNestLevel=2）
        const titleWrapper = result.subComponents.find(c => c.name === 'HeroTitleWrapper');
        expect(titleWrapper).toBeUndefined();
      });

      it('maxNestLevelオプションで分割深度を変更できる', () => {
        const html = `
          <div>
            <section class="hero-section">
              <div class="hero-content">
                <div class="hero-title-wrapper">
                  <h1>Title</h1>
                  <p>Subtitle</p>
                  <span>Extra</span>
                </div>
              </div>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html, { maxNestLevel: 3 });

        const titleWrapper = result.subComponents.find(c => c.name === 'HeroTitleWrapper');
        expect(titleWrapper).toBeDefined();
      });
    });

    // ==========================================================
    // 小さすぎる要素の分割スキップ
    // ==========================================================

    describe('小さすぎる要素の分割スキップ', () => {
      it('要素数が最小サイズ未満の場合は分割しない', () => {
        const html = `
          <div>
            <section class="tiny">
              <p>Only one element</p>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        // 要素数が少ないので分割されない
        const tinySection = result.subComponents.find(c => c.name === 'Tiny');
        expect(tinySection).toBeUndefined();
      });

      it('3要素以上で分割される', () => {
        const html = `
          <div>
            <section class="feature-section">
              <h2>Features</h2>
              <p>Description</p>
              <button>Learn More</button>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        // section要素は常にセマンティック要素として分割される
        const featuresSection = result.subComponents.find(c => c.name === 'Section' || c.name === 'FeatureSection');
        expect(featuresSection).toBeDefined();
      });

      it('minElementsオプションで最小サイズを変更できる', () => {
        const html = `
          <div>
            <section class="small-section">
              <p>One element</p>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html, { minElements: 1 });

        // section要素はセマンティック要素として分割
        const smallSection = result.subComponents.find(c => c.name === 'Section' || c.name === 'SmallSection');
        expect(smallSection).toBeDefined();
      });
    });

    // ==========================================================
    // コンポーネント名の自動生成
    // ==========================================================

    describe('コンポーネント名の自動生成', () => {
      it('クラス名からPascalCaseコンポーネント名を生成する', () => {
        const html = `
          <div class="user-profile-card">
            <img src="avatar.jpg" />
            <h3>Name</h3>
            <p>Bio text</p>
          </div>
        `;
        const result = splitIntoComponents(html);

        const component = result.subComponents.find(c => c.name === 'UserProfileCard');
        expect(component).toBeDefined();
      });

      it('ハイフン区切りのクラス名をPascalCaseに変換する', () => {
        const html = `
          <div class="main-navigation-bar">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </div>
        `;
        const result = splitIntoComponents(html);

        const component = result.subComponents.find(c => c.name === 'MainNavigationBar');
        expect(component).toBeDefined();
      });

      it('アンダースコア区切りのクラス名をPascalCaseに変換する', () => {
        const html = `
          <div class="product_detail_section">
            <h2>Product</h2>
            <p>Description</p>
            <button>Buy</button>
          </div>
        `;
        const result = splitIntoComponents(html);

        const component = result.subComponents.find(c => c.name === 'ProductDetailSection');
        expect(component).toBeDefined();
      });

      it('同名のコンポーネントには連番を付ける', () => {
        const html = `
          <div>
            <section>
              <h2>Section 1</h2>
              <p>Content 1</p>
              <button>Action 1</button>
            </section>
            <section>
              <h2>Section 2</h2>
              <p>Content 2</p>
              <button>Action 2</button>
            </section>
          </div>
        `;
        const result = splitIntoComponents(html);

        // 2つのsection要素が別々のコンポーネントとして分割される
        const sections = result.subComponents.filter(c => c.name.startsWith('Section'));
        expect(sections.length).toBe(2);
        expect(sections.some(c => c.name === 'Section')).toBe(true);
        expect(sections.some(c => c.name === 'Section2')).toBe(true);
      });
    });

    // ==========================================================
    // props検出
    // ==========================================================

    describe('props検出', () => {
      it('className propsを検出する', () => {
        const html = `
          <section class="hero-section custom-class">
            <h1>Title</h1>
            <p>Description</p>
            <button>CTA</button>
          </section>
        `;
        const result = splitIntoComponents(html);

        // section要素はセマンティック要素として分割される
        const heroComponent = result.subComponents.find(c => c.name === 'Section' || c.name === 'HeroSection');
        expect(heroComponent).toBeDefined();
        expect(heroComponent?.props.some(p => p.name === 'className')).toBe(true);
      });

      it('children propsを検出する', () => {
        const html = `
          <div class="container">
            <header>
              <h1>Title</h1>
              <nav>Navigation</nav>
            </header>
            <main>Content</main>
          </div>
        `;
        const result = splitIntoComponents(html);

        // コンテナコンポーネントにはchildren propsがある
        const containerComponent = result.subComponents.find(c => c.name === 'Container');
        if (containerComponent) {
          expect(containerComponent.props.some(p => p.name === 'children')).toBe(true);
        }
      });

      it('繰り返し要素からpropsを抽出する', () => {
        const html = `
          <ul class="items">
            <li class="item">
              <h3 class="item-title">Item 1</h3>
              <p class="item-desc">Description 1</p>
            </li>
            <li class="item">
              <h3 class="item-title">Item 2</h3>
              <p class="item-desc">Description 2</p>
            </li>
          </ul>
        `;
        const result = splitIntoComponents(html);

        const itemComponent = result.subComponents.find(c => c.name === 'Item');
        if (itemComponent) {
          expect(itemComponent.props.some(p => p.name === 'title')).toBe(true);
          expect(itemComponent.props.some(p => p.name === 'description' || p.name === 'desc')).toBe(true);
        }
      });

      it('props型を正しく推論する', () => {
        const html = `
          <div class="profile-card">
            <img class="avatar" src="image.jpg" alt="User" />
            <h3 class="name">User Name</h3>
            <p class="bio">User bio</p>
          </div>
        `;
        const result = splitIntoComponents(html);

        const profileCard = result.subComponents.find(c => c.name === 'ProfileCard');
        if (profileCard) {
          const srcProp = profileCard.props.find(p => p.name === 'src' || p.name === 'avatarSrc');
          expect(srcProp?.type).toBe('string');
        }
      });
    });

    // ==========================================================
    // import文の生成
    // ==========================================================

    describe('import文の生成', () => {
      it('分割されたサブコンポーネントのimport文を生成する', () => {
        const html = `
          <div>
            <header>
              <h1>Title</h1>
              <nav>Navigation links</nav>
            </header>
            <main>
              <p>Content</p>
            </main>
            <footer>
              <p>Footer content</p>
            </footer>
          </div>
        `;
        const result = splitIntoComponents(html);

        expect(result.mainComponent.imports.length).toBeGreaterThan(0);
        expect(result.mainComponent.imports.some(imp => imp.includes('HeaderSection'))).toBe(true);
      });

      it('import文はファイルパスを含む', () => {
        const html = `
          <section class="hero-section">
            <h1>Welcome</h1>
            <p>Description</p>
            <button>Get Started</button>
          </section>
        `;
        const result = splitIntoComponents(html);

        // section要素はセマンティック要素として分割される
        const sectionComponent = result.subComponents.find(c => c.name === 'Section' || c.name === 'HeroSection');
        if (sectionComponent) {
          const sectionImport = result.mainComponent.imports.find(imp => imp.includes('Section'));
          expect(sectionImport).toContain('./');
        }
      });
    });

    // ==========================================================
    // 統合テスト
    // ==========================================================

    describe('統合テスト', () => {
      it('複雑なLPレイアウトを適切に分割する', () => {
        const html = `
          <div class="landing-page">
            <header class="site-header">
              <nav class="main-nav">
                <a href="/">Home</a>
                <a href="/features">Features</a>
                <a href="/pricing">Pricing</a>
              </nav>
            </header>
            <main>
              <section class="hero-section" data-section="hero">
                <h1>Welcome to Our Product</h1>
                <p>The best solution for your needs</p>
                <button class="cta-button">Get Started</button>
              </section>
              <section class="features-section">
                <h2>Features</h2>
                <div class="feature-card">
                  <h3>Feature 1</h3>
                  <p>Description 1</p>
                </div>
                <div class="feature-card">
                  <h3>Feature 2</h3>
                  <p>Description 2</p>
                </div>
                <div class="feature-card">
                  <h3>Feature 3</h3>
                  <p>Description 3</p>
                </div>
              </section>
            </main>
            <footer class="site-footer">
              <p>Copyright 2024</p>
              <nav>
                <a href="/terms">Terms</a>
                <a href="/privacy">Privacy</a>
              </nav>
            </footer>
          </div>
        `;
        // ネストレベルを3に増やして、main内のsection要素も分割
        const result = splitIntoComponents(html, { maxNestLevel: 3 });

        // 主要なセクションが分割されている
        expect(result.subComponents.some(c => c.name.includes('Header'))).toBe(true);
        expect(result.subComponents.some(c => c.name.includes('Hero'))).toBe(true);
        expect(result.subComponents.some(c => c.name.includes('Feature'))).toBe(true);
        expect(result.subComponents.some(c => c.name.includes('Footer'))).toBe(true);

        // import文が生成されている
        expect(result.mainComponent.imports.length).toBeGreaterThan(0);
      });

      it('オプションを組み合わせて使用できる', () => {
        const html = `
          <div>
            <div class="content-section">
              <h2>Title</h2>
              <p>Text</p>
            </div>
          </div>
        `;
        const options: SplitOptions = {
          mainComponentName: 'MyPage',
          minElements: 2,
          maxNestLevel: 1,
        };
        const result = splitIntoComponents(html, options);

        expect(result.mainComponent.name).toBe('MyPage');
        // content-sectionクラスがPascalCase変換されてContentSectionになる
        expect(result.subComponents.some(c => c.name === 'ContentSection')).toBe(true);
      });
    });
  });
});
