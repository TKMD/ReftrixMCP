// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OSSライセンスチェック テスト
 *
 * テスト対象: LicenseChecker Service
 *
 * このテストは以下を検証します:
 * - 依存関係のライセンス一覧取得
 * - 禁止ライセンスの検出
 * - ライセンス互換性チェック
 * - NOTICE/ATTRIBUTIONファイル生成
 * - ライセンスレポート出力
 */

import { describe, it, expect, beforeEach } from 'vitest';

// モック: パッケージ情報
interface PackageInfo {
  name: string;
  version: string;
  license: string;
  repository?: string;
  author?: string;
  homepage?: string;
}

// モック: ライセンス情報
interface LicenseInfo extends PackageInfo {
  licenseText?: string;
  isAllowed: boolean;
  isProblematic: boolean;
  reason?: string;
}

// モック: ライセンスポリシー
interface LicensePolicy {
  allowed: string[];
  disallowed: string[];
  requiresAttribution: string[];
}

// モック: ライセンスレポート
interface LicenseReport {
  totalPackages: number;
  allowedCount: number;
  problematicCount: number;
  licenses: LicenseInfo[];
  violations: LicenseInfo[];
  summary: {
    [license: string]: number;
  };
}

// デフォルトポリシー
const DEFAULT_POLICY: LicensePolicy = {
  allowed: [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'CC0-1.0',
    'Unlicense',
    '0BSD',
  ],
  disallowed: [
    'GPL-2.0',
    'GPL-3.0',
    'AGPL-3.0',
    'LGPL-2.1',
    'LGPL-3.0',
    'CC-BY-NC-4.0',
    'CC-BY-NC-SA-4.0',
  ],
  requiresAttribution: [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
  ],
};

// モック: ライセンスチェッカーサービス
class LicenseChecker {
  private policy: LicensePolicy;

  constructor(policy: LicensePolicy = DEFAULT_POLICY) {
    this.policy = policy;
  }

  /**
   * package.jsonから依存関係のライセンス一覧を取得
   */
  async getDependencyLicenses(
    packageJsonPath: string
  ): Promise<LicenseInfo[]> {
    // モック: 実際はpackage.jsonを読み込んでnode_modulesを解析
    const mockDependencies: PackageInfo[] = [
      {
        name: 'next',
        version: '16.0.0',
        license: 'MIT',
        repository: 'https://github.com/vercel/next.js',
        author: 'Vercel',
      },
      {
        name: 'react',
        version: '19.0.0',
        license: 'MIT',
        repository: 'https://github.com/facebook/react',
        author: 'Meta',
      },
      {
        name: '@prisma/client',
        version: '6.0.0',
        license: 'Apache-2.0',
        repository: 'https://github.com/prisma/prisma',
      },
      {
        name: 'vitest',
        version: '4.0.0',
        license: 'MIT',
        repository: 'https://github.com/vitest-dev/vitest',
      },
      {
        name: 'some-gpl-package',
        version: '1.0.0',
        license: 'GPL-3.0',
        repository: 'https://example.com/gpl',
      },
    ];

    return mockDependencies.map((pkg) => this.checkLicense(pkg));
  }

  /**
   * 単一パッケージのライセンスをチェック
   */
  checkLicense(pkg: PackageInfo): LicenseInfo {
    const isAllowed = this.isLicenseAllowed(pkg.license);
    const isProblematic = this.isLicenseProblematic(pkg.license);

    let reason: string | undefined;
    if (isProblematic) {
      reason = `License ${pkg.license} is not allowed by policy`;
    }

    return {
      ...pkg,
      isAllowed,
      isProblematic,
      reason,
    };
  }

  /**
   * ライセンスが許可されているかチェック
   */
  isLicenseAllowed(license: string): boolean {
    // 複数ライセンスの場合（OR/AND）
    if (license.includes(' OR ')) {
      return license.split(' OR ').some((l) => this.policy.allowed.includes(l.trim()));
    }

    if (license.includes(' AND ')) {
      return license.split(' AND ').every((l) => this.policy.allowed.includes(l.trim()));
    }

    return this.policy.allowed.includes(license);
  }

  /**
   * ライセンスが禁止されているかチェック
   */
  isLicenseProblematic(license: string): boolean {
    if (license.includes(' OR ')) {
      return license.split(' OR ').every((l) => this.policy.disallowed.includes(l.trim()));
    }

    if (license.includes(' AND ')) {
      return license.split(' AND ').some((l) => this.policy.disallowed.includes(l.trim()));
    }

    return this.policy.disallowed.includes(license);
  }

  /**
   * ライセンス互換性をチェック
   */
  checkCompatibility(licenses: string[]): {
    compatible: boolean;
    conflicts: string[];
  } {
    const conflicts: string[] = [];

    // GPL系とMITの組み合わせチェック
    const hasGPL = licenses.some((l) => l.startsWith('GPL') || l.startsWith('AGPL'));
    const hasMIT = licenses.includes('MIT');

    if (hasGPL && hasMIT) {
      conflicts.push('GPL licenses are incompatible with permissive licenses like MIT');
    }

    return {
      compatible: conflicts.length === 0,
      conflicts,
    };
  }

  /**
   * ライセンスレポートを生成
   */
  async generateReport(packageJsonPath: string): Promise<LicenseReport> {
    const licenses = await this.getDependencyLicenses(packageJsonPath);

    const violations = licenses.filter((l) => l.isProblematic);
    const summary: { [license: string]: number } = {};

    licenses.forEach((l) => {
      summary[l.license] = (summary[l.license] || 0) + 1;
    });

    return {
      totalPackages: licenses.length,
      allowedCount: licenses.filter((l) => l.isAllowed).length,
      problematicCount: violations.length,
      licenses,
      violations,
      summary,
    };
  }

  /**
   * NOTICEファイルを生成
   */
  async generateNoticeFile(packageJsonPath: string): Promise<string> {
    const licenses = await this.getDependencyLicenses(packageJsonPath);

    // 帰属表示が必要なパッケージをフィルタ
    const attributionRequired = licenses.filter((l) =>
      this.policy.requiresAttribution.includes(l.license)
    );

    let notice = '# Third-Party Software Notices\n\n';
    notice += `This software includes the following third-party packages:\n\n`;

    for (const pkg of attributionRequired) {
      notice += `## ${pkg.name} (${pkg.version})\n\n`;
      notice += `License: ${pkg.license}\n`;

      if (pkg.author) {
        notice += `Author: ${pkg.author}\n`;
      }

      if (pkg.repository) {
        notice += `Repository: ${pkg.repository}\n`;
      }

      if (pkg.homepage) {
        notice += `Homepage: ${pkg.homepage}\n`;
      }

      notice += '\n---\n\n';
    }

    return notice;
  }

  /**
   * ATTRIBUTIONファイルを生成（簡易版）
   */
  async generateAttributionFile(packageJsonPath: string): Promise<string> {
    const licenses = await this.getDependencyLicenses(packageJsonPath);

    let attribution = 'THIRD-PARTY SOFTWARE ATTRIBUTION\n\n';

    for (const pkg of licenses) {
      attribution += `${pkg.name} ${pkg.version} - ${pkg.license}\n`;
    }

    return attribution;
  }

  /**
   * ライセンスサマリーをテキスト形式で出力
   */
  formatReportText(report: LicenseReport): string {
    let text = '=== License Report ===\n\n';
    text += `Total Packages: ${report.totalPackages}\n`;
    text += `Allowed: ${report.allowedCount}\n`;
    text += `Problematic: ${report.problematicCount}\n\n`;

    text += '=== License Summary ===\n';
    for (const [license, count] of Object.entries(report.summary)) {
      text += `${license}: ${count}\n`;
    }

    if (report.violations.length > 0) {
      text += '\n=== Violations ===\n';
      for (const violation of report.violations) {
        text += `- ${violation.name} (${violation.license}): ${violation.reason}\n`;
      }
    }

    return text;
  }

  /**
   * ライセンスレポートをJSON形式で出力
   */
  formatReportJson(report: LicenseReport): string {
    return JSON.stringify(report, null, 2);
  }
}

describe('LicenseChecker', () => {
  let checker: LicenseChecker;

  beforeEach(() => {
    checker = new LicenseChecker();
  });

  describe('ライセンス一覧取得', () => {
    it('依存関係のライセンス一覧を取得できること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const licenses = await checker.getDependencyLicenses(packageJsonPath);

      // Assert
      expect(licenses.length).toBeGreaterThan(0);
      expect(licenses[0]).toHaveProperty('name');
      expect(licenses[0]).toHaveProperty('version');
      expect(licenses[0]).toHaveProperty('license');
      expect(licenses[0]).toHaveProperty('isAllowed');
      expect(licenses[0]).toHaveProperty('isProblematic');
    });

    it('各パッケージが必要な情報を含むこと', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const licenses = await checker.getDependencyLicenses(packageJsonPath);

      // Assert
      licenses.forEach((license) => {
        expect(license.name).toBeDefined();
        expect(license.version).toBeDefined();
        expect(license.license).toBeDefined();
      });
    });
  });

  describe('ライセンス判定', () => {
    it('MITライセンスが許可されること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'MIT',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(true);
      expect(result.isProblematic).toBe(false);
    });

    it('Apache-2.0ライセンスが許可されること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'Apache-2.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(true);
      expect(result.isProblematic).toBe(false);
    });

    it('GPL-3.0ライセンスが禁止されること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'GPL-3.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(false);
      expect(result.isProblematic).toBe(true);
      expect(result.reason).toContain('not allowed');
    });

    it('AGPL-3.0ライセンスが禁止されること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'AGPL-3.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(false);
      expect(result.isProblematic).toBe(true);
    });
  });

  describe('複数ライセンス判定', () => {
    it('OR条件のライセンス（いずれかが許可）を正しく判定すること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'MIT OR Apache-2.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(true);
      expect(result.isProblematic).toBe(false);
    });

    it('AND条件のライセンス（すべてが許可）を正しく判定すること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'MIT AND BSD-3-Clause',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(true);
    });

    it('OR条件で両方禁止の場合、禁止と判定すること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'GPL-2.0 OR GPL-3.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isProblematic).toBe(true);
    });

    it('AND条件で一つでも禁止の場合、禁止と判定すること', () => {
      // Arrange
      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'MIT AND GPL-3.0',
      };

      // Act
      const result = checker.checkLicense(pkg);

      // Assert
      expect(result.isProblematic).toBe(true);
    });
  });

  describe('ライセンス互換性チェック', () => {
    it('MIT同士は互換性があること', () => {
      // Arrange
      const licenses = ['MIT', 'MIT'];

      // Act
      const result = checker.checkCompatibility(licenses);

      // Assert
      expect(result.compatible).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('MITとApache-2.0は互換性があること', () => {
      // Arrange
      const licenses = ['MIT', 'Apache-2.0'];

      // Act
      const result = checker.checkCompatibility(licenses);

      // Assert
      expect(result.compatible).toBe(true);
    });

    it('GPLとMITは互換性がないこと', () => {
      // Arrange
      const licenses = ['GPL-3.0', 'MIT'];

      // Act
      const result = checker.checkCompatibility(licenses);

      // Assert
      expect(result.compatible).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('ライセンスレポート生成', () => {
    it('正しい統計情報を含むレポートを生成すること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const report = await checker.generateReport(packageJsonPath);

      // Assert
      expect(report.totalPackages).toBeGreaterThan(0);
      expect(report.allowedCount).toBeGreaterThan(0);
      expect(report.licenses).toHaveLength(report.totalPackages);
    });

    it('違反パッケージを含むレポートを生成すること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const report = await checker.generateReport(packageJsonPath);

      // Assert
      expect(report.violations.length).toBeGreaterThan(0);
      expect(report.violations[0].license).toBe('GPL-3.0');
    });

    it('ライセンスサマリーを含むレポートを生成すること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const report = await checker.generateReport(packageJsonPath);

      // Assert
      expect(report.summary).toBeDefined();
      expect(report.summary['MIT']).toBeGreaterThan(0);
    });
  });

  describe('NOTICEファイル生成', () => {
    it('NOTICEファイルを生成できること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const notice = await checker.generateNoticeFile(packageJsonPath);

      // Assert
      expect(notice).toContain('Third-Party Software Notices');
      expect(notice).toContain('next');
      expect(notice).toContain('react');
    });

    it('各パッケージのライセンス情報を含むこと', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const notice = await checker.generateNoticeFile(packageJsonPath);

      // Assert
      expect(notice).toContain('License: MIT');
      expect(notice).toContain('License: Apache-2.0');
    });

    it('リポジトリURLを含むこと', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const notice = await checker.generateNoticeFile(packageJsonPath);

      // Assert
      expect(notice).toContain('https://github.com/vercel/next.js');
      expect(notice).toContain('https://github.com/facebook/react');
    });
  });

  describe('ATTRIBUTIONファイル生成', () => {
    it('ATTRIBUTIONファイルを生成できること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';

      // Act
      const attribution = await checker.generateAttributionFile(packageJsonPath);

      // Assert
      expect(attribution).toContain('THIRD-PARTY SOFTWARE ATTRIBUTION');
      expect(attribution).toContain('next 16.0.0 - MIT');
      expect(attribution).toContain('react 19.0.0 - MIT');
    });
  });

  describe('レポートフォーマット', () => {
    it('テキスト形式でレポートをフォーマットできること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';
      const report = await checker.generateReport(packageJsonPath);

      // Act
      const text = checker.formatReportText(report);

      // Assert
      expect(text).toContain('=== License Report ===');
      expect(text).toContain('Total Packages:');
      expect(text).toContain('=== License Summary ===');
      expect(text).toContain('MIT:');
    });

    it('違反がある場合、違反セクションを含むこと', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';
      const report = await checker.generateReport(packageJsonPath);

      // Act
      const text = checker.formatReportText(report);

      // Assert
      expect(text).toContain('=== Violations ===');
      expect(text).toContain('some-gpl-package');
    });

    it('JSON形式でレポートをフォーマットできること', async () => {
      // Arrange
      const packageJsonPath = '/fake/path/package.json';
      const report = await checker.generateReport(packageJsonPath);

      // Act
      const json = checker.formatReportJson(report);

      // Assert
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json);
      expect(parsed.totalPackages).toBeDefined();
      expect(parsed.licenses).toBeDefined();
    });
  });

  describe('カスタムポリシー', () => {
    it('カスタムポリシーを適用できること', () => {
      // Arrange
      const customPolicy: LicensePolicy = {
        allowed: ['MIT'],
        disallowed: ['Apache-2.0'],
        requiresAttribution: ['MIT'],
      };

      const customChecker = new LicenseChecker(customPolicy);

      const pkg: PackageInfo = {
        name: 'test-package',
        version: '1.0.0',
        license: 'Apache-2.0',
      };

      // Act
      const result = customChecker.checkLicense(pkg);

      // Assert
      expect(result.isAllowed).toBe(false);
      expect(result.isProblematic).toBe(true);
    });
  });
});
