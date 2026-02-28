// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TemplateEngine,
  Template,
  TemplateContext,
} from '../../src/template-engine';

describe('TemplateEngine', () => {
  let engine: TemplateEngine;

  beforeEach(() => {
    engine = new TemplateEngine();
  });

  // =====================================
  // 基本機能テスト (10件)
  // =====================================
  describe('コンストラクタ・初期化', () => {
    it('インスタンスが正しく作成される', () => {
      expect(engine).toBeInstanceOf(TemplateEngine);
    });

    it('初期状態でテンプレートが空である', () => {
      expect(engine.has('hero', 'react')).toBe(false);
    });
  });

  describe('テンプレート登録', () => {
    it('テンプレートを登録できる', () => {
      const template: Template = {
        id: 'test-hero',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };

      engine.register(template);
      expect(engine.has('hero', 'react')).toBe(true);
    });

    it('同じIDのテンプレートは上書きされる', () => {
      const template1: Template = {
        id: 'test-hero',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };
      const template2: Template = {
        id: 'test-hero',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{heading}}</div>',
      };

      engine.register(template1);
      engine.register(template2);

      const result = engine.get('hero', 'react');
      expect(result?.content).toBe('<div>{{heading}}</div>');
    });

    it('複数のテンプレートを登録できる', () => {
      const template1: Template = {
        id: 'hero-react',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };
      const template2: Template = {
        id: 'hero-html',
        sectionType: 'hero',
        framework: 'html',
        content: '<div>{{title}}</div>',
      };

      engine.register(template1);
      engine.register(template2);

      expect(engine.has('hero', 'react')).toBe(true);
      expect(engine.has('hero', 'html')).toBe(true);
    });
  });

  describe('テンプレート取得', () => {
    beforeEach(() => {
      const template: Template = {
        id: 'test-hero',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };
      engine.register(template);
    });

    it('登録したテンプレートを取得できる', () => {
      const result = engine.get('hero', 'react');
      expect(result).toBeDefined();
      expect(result?.id).toBe('test-hero');
    });

    it('存在しないテンプレートはundefinedを返す', () => {
      const result = engine.get('navigation', 'react');
      expect(result).toBeUndefined();
    });
  });

  describe('テンプレート削除', () => {
    it('登録したテンプレートを削除できる', () => {
      const template: Template = {
        id: 'test-hero',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };

      engine.register(template);
      expect(engine.has('hero', 'react')).toBe(true);

      const deleted = engine.unregister('test-hero');
      expect(deleted).toBe(true);
      expect(engine.has('hero', 'react')).toBe(false);
    });

    it('存在しないテンプレートの削除はfalseを返す', () => {
      const deleted = engine.unregister('non-existent');
      expect(deleted).toBe(false);
    });
  });

  // =====================================
  // 変数置換テスト (15件)
  // =====================================
  describe('単純な変数置換', () => {
    it('単一変数を置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Hello World',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Hello World</div>');
    });

    it('複数の変数を置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<h1>{{title}}</h1><p>{{subtitle}}</p>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Welcome',
        subtitle: 'To our site',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<h1>Welcome</h1><p>To our site</p>');
    });

    it('存在しない変数は空文字に置換される', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{nonExistent}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div></div>');
    });

    it('数値変数を置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{count}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        count: 42,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>42</div>');
    });

    it('真偽値変数を置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{isActive}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        isActive: true,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>true</div>');
    });
  });

  describe('ネストした変数置換', () => {
    it('オブジェクトのプロパティを置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{user.name}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        user: { name: 'John Doe' },
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>John Doe</div>');
    });

    it('深くネストしたプロパティを置換できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{user.address.city}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        user: {
          address: {
            city: 'Tokyo',
          },
        },
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Tokyo</div>');
    });

    it('存在しないネストプロパティは空文字になる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{user.profile.bio}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        user: { name: 'John' },
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div></div>');
    });
  });

  describe('デフォルト値', () => {
    it('変数が存在しない場合デフォルト値を使用', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title|Untitled}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Untitled</div>');
    });

    it('変数が存在する場合はデフォルト値を無視', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title|Untitled}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'My Title',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>My Title</div>');
    });

    it('空文字の場合もデフォルト値を使用', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title|Default Title}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: '',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Default Title</div>');
    });

    it('デフォルト値にスペースを含められる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title|Default Title Here}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Default Title Here</div>');
    });
  });

  // =====================================
  // 条件分岐テスト (15件)
  // =====================================
  describe('if条件分岐', () => {
    it('真の場合ブロックを表示', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if showTitle}}<h1>Title</h1>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        showTitle: true,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<h1>Title</h1>');
    });

    it('偽の場合ブロックを非表示', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if showTitle}}<h1>Title</h1>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        showTitle: false,
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('存在しない変数は偽として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if nonExistent}}<h1>Title</h1>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('空文字は偽として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if title}}<h1>{{title}}</h1>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: '',
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('0は偽として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if count}}<p>{{count}}</p>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        count: 0,
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('空配列は偽として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if items}}<ul>Items</ul>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        items: [],
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('非空配列は真として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if items}}<ul>Items</ul>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        items: [1, 2, 3],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul>Items</ul>');
    });

    it('ネストしたif条件を処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content:
          '{{#if outer}}Outer{{#if inner}} Inner{{/if}}{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        outer: true,
        inner: true,
      };

      const result = engine.render(template, context);
      expect(result).toBe('Outer Inner');
    });

    it('複数のif条件を処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content:
          '{{#if title}}<h1>{{title}}</h1>{{/if}}{{#if subtitle}}<p>{{subtitle}}</p>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Welcome',
        subtitle: 'Hello',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<h1>Welcome</h1><p>Hello</p>');
    });

    it('if条件内で変数置換ができる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{#if user}}<p>Hello {{user.name}}</p>{{/if}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        user: { name: 'Alice' },
      };

      const result = engine.render(template, context);
      expect(result).toBe('<p>Hello Alice</p>');
    });
  });

  // =====================================
  // ループテスト (15件)
  // =====================================
  describe('each ループ', () => {
    it('配列をループ処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content: '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        items: ['Apple', 'Banana', 'Cherry'],
      };

      const result = engine.render(template, context);
      expect(result).toBe(
        '<ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>'
      );
    });

    it('空配列の場合は何も出力しない', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content: '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        items: [],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul></ul>');
    });

    it('オブジェクト配列をループ処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content: '<ul>{{#each users}}<li>{{name}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        users: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul><li>Alice</li><li>Bob</li><li>Charlie</li></ul>');
    });

    it('ネストしたプロパティにアクセスできる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content:
          '<ul>{{#each users}}<li>{{profile.age}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        users: [
          { profile: { age: 25 } },
          { profile: { age: 30 } },
          { profile: { age: 35 } },
        ],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul><li>25</li><li>30</li><li>35</li></ul>');
    });

    it('ループ内でインデックスを使用できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content:
          '<ul>{{#each items}}<li>{{@index}}: {{this}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        items: ['First', 'Second', 'Third'],
      };

      const result = engine.render(template, context);
      expect(result).toBe(
        '<ul><li>0: First</li><li>1: Second</li><li>2: Third</li></ul>'
      );
    });

    it('ループがネストできる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content:
          '{{#each categories}}<h2>{{name}}</h2><ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>{{/each}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        categories: [
          { name: 'Fruits', items: ['Apple', 'Banana'] },
          { name: 'Vegetables', items: ['Carrot', 'Broccoli'] },
        ],
      };

      const result = engine.render(template, context);
      expect(result).toBe(
        '<h2>Fruits</h2><ul><li>Apple</li><li>Banana</li></ul><h2>Vegetables</h2><ul><li>Carrot</li><li>Broccoli</li></ul>'
      );
    });

    it('ループ内でif条件を使用できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content:
          '<ul>{{#each users}}{{#if active}}<li>{{name}}</li>{{/if}}{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        users: [
          { name: 'Alice', active: true },
          { name: 'Bob', active: false },
          { name: 'Charlie', active: true },
        ],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul><li>Alice</li><li>Charlie</li></ul>');
    });

    it('数値配列をループ処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'feature',
        framework: 'react',
        content: '<ul>{{#each numbers}}<li>{{this}}</li>{{/each}}</ul>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'feature' } as any,
        options: { framework: 'react' } as any,
        numbers: [1, 2, 3, 4, 5],
      };

      const result = engine.render(template, context);
      expect(result).toBe('<ul><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ul>');
    });
  });

  // =====================================
  // renderByType テスト (5件)
  // =====================================
  describe('renderByType', () => {
    it('セクションタイプとフレームワークでレンダリングできる', () => {
      const template: Template = {
        id: 'hero-react',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{title}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Test',
      };

      const result = engine.renderByType('hero', 'react', context);
      expect(result).toBe('<div>Test</div>');
    });

    it('存在しないテンプレートでエラーを投げる', () => {
      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      expect(() => {
        engine.renderByType('hero', 'react', context);
      }).toThrow();
    });

    it('異なるフレームワークのテンプレートを区別できる', () => {
      const reactTemplate: Template = {
        id: 'hero-react',
        sectionType: 'hero',
        framework: 'react',
        content: '<div className="hero">{{title}}</div>',
      };
      const htmlTemplate: Template = {
        id: 'hero-html',
        sectionType: 'hero',
        framework: 'html',
        content: '<div class="hero">{{title}}</div>',
      };

      engine.register(reactTemplate);
      engine.register(htmlTemplate);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Test',
      };

      const reactResult = engine.renderByType('hero', 'react', context);
      const htmlResult = engine.renderByType('hero', 'html', context);

      expect(reactResult).toBe('<div className="hero">Test</div>');
      expect(htmlResult).toBe('<div class="hero">Test</div>');
    });
  });

  // =====================================
  // コメント機能テスト (5件)
  // =====================================
  describe('コメント', () => {
    it('コメントは出力されない', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{! This is a comment }}{{title}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Hello',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Hello</div>');
    });

    it('複数行コメントを処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: `<div>
{{! This is a
    multi-line comment }}
{{title}}
</div>`,
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Test',
      };

      const result = engine.render(template, context);
      expect(result.trim()).toContain('Test');
      expect(result).not.toContain('comment');
    });

    it('コメント内の変数構文は無視される', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{! {{variable}} }}{{title}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Hello',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Hello</div>');
    });
  });

  // =====================================
  // エッジケーステスト (10件)
  // =====================================
  describe('エッジケース', () => {
    it('空のテンプレートを処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('');
    });

    it('変数構文のない通常のテキストを処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>Plain text without variables</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>Plain text without variables</div>');
    });

    it('HTMLエンティティをエスケープしない（生出力）', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{html}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        html: '<span>Bold</span>',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div><span>Bold</span></div>');
    });

    it('改行を含むテンプレートを処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: `<div>
  <h1>{{title}}</h1>
  <p>{{subtitle}}</p>
</div>`,
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Title',
        subtitle: 'Subtitle',
      };

      const result = engine.render(template, context);
      expect(result).toContain('Title');
      expect(result).toContain('Subtitle');
    });

    it('特殊文字を含む変数を処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{message}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        message: "It's a <test> & \"example\"",
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>It\'s a <test> & "example"</div>');
    });

    it('連続する変数を処理できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '{{first}}{{second}}{{third}}',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        first: 'A',
        second: 'B',
        third: 'C',
      };

      const result = engine.render(template, context);
      expect(result).toBe('ABC');
    });

    it('同じ変数を複数回使用できる', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<h1>{{title}}</h1><p>{{title}}</p>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        title: 'Same Title',
      };

      const result = engine.render(template, context);
      expect(result).toBe('<h1>Same Title</h1><p>Same Title</p>');
    });

    it('未定義のネストプロパティで例外を投げない', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{deeply.nested.property.that.does.not.exist}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div></div>');
    });

    it('nullとundefinedを空文字として扱う', () => {
      const template: Template = {
        id: 'test',
        sectionType: 'hero',
        framework: 'react',
        content: '<div>{{nullValue}}|{{undefinedValue}}</div>',
      };

      engine.register(template);

      const context: TemplateContext = {
        section: { type: 'hero' } as any,
        options: { framework: 'react' } as any,
        nullValue: null,
        undefinedValue: undefined,
      };

      const result = engine.render(template, context);
      expect(result).toBe('<div>|</div>');
    });
  });
});
