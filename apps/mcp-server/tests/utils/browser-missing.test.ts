// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-BROWSER-MISSING-FIXED-MESSAGE-001 (R-06a / R-48 / R-51 / R-14 (d) / R-18 (vi))
 *
 * ブラウザ欠如エラーを固定文言に置換し、内部 path を client に出さない。
 * Replace the browser-missing launch error with a fixed message; never leak internal paths.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_MISSING_MESSAGE,
  PLAYWRIGHT_PINNED_VERSION,
  isBrowserMissingError,
  BrowserNotInstalledError,
} from "../../src/utils/browser-missing";
import { sanitizeErrorMessage } from "../../src/utils/sanitize-error";

const PKG_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");

// playwright-core 1.57.0 の 2 variant / the two variants in playwright-core 1.57.0
const VARIANT_UPPER =
  "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell\n" +
  "║     npx playwright install                                              ║";
const VARIANT_LOWER =
  "browserType.launch: executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";

const LEAK_PATTERNS = [/\/home\//, /ms-playwright/, /\.cache/, /Call log:/, /\n\s+at /];

describe("INV-SEC-BROWSER-MISSING-FIXED-MESSAGE-001", () => {
  describe("BrowserNotInstalledError", () => {
    it("is recognised by instanceof, even if its message were changed", () => {
      const err = new BrowserNotInstalledError();
      err.message = "something unrelated";
      expect(isBrowserMissingError(err)).toBe(true);
    });
    it("carries the fixed message", () => {
      expect(new BrowserNotInstalledError().message).toBe(BROWSER_MISSING_MESSAGE);
    });
  });

  describe("isBrowserMissingError (2 variant OR, lower-cased)", () => {
    it("matches the upper-case 'Executable doesn't exist at' variant", () => {
      expect(isBrowserMissingError(new Error(VARIANT_UPPER))).toBe(true);
    });
    it("matches the lower-case 'executable doesn't exist at' variant (browserType.js:178)", () => {
      expect(isBrowserMissingError(new Error(VARIANT_LOWER))).toBe(true);
    });
    it("matches the 'npx playwright install' hint alone", () => {
      expect(isBrowserMissingError(new Error("please run npx playwright install"))).toBe(true);
    });
    it("does not match Playwright's missing-host-dependencies text (install-deps)", () => {
      // playwright-core 1.57.0 registry/dependencies.js: wrong remedy if matched
      const deps =
        "browserType.launch: Host system is missing dependencies to run browsers.\n" +
        "Please install them with the following command:\n\n" +
        "    sudo npx playwright install-deps\n\n" +
        "Alternatively, use apt:\n    sudo apt-get install libnss3\n\n<3 Playwright Team";
      expect(isBrowserMissingError(new Error(deps))).toBe(false);
      expect(isBrowserMissingError(new Error("run npx playwright install-deps chromium"))).toBe(
        false
      );
      expect(sanitizeErrorMessage(new Error(deps))).not.toBe(BROWSER_MISSING_MESSAGE);
    });
    it("still matches the plain 'npx playwright install' hint variants", () => {
      expect(isBrowserMissingError(new Error("run npx playwright install\n"))).toBe(true);
      expect(isBrowserMissingError(new Error("run npx playwright install chromium"))).toBe(true);
    });
    it("does not match unrelated errors (negative cases)", () => {
      expect(isBrowserMissingError(new Error("net::ERR_NAME_NOT_RESOLVED at https://x.test"))).toBe(
        false
      );
      expect(isBrowserMissingError(new Error("Target closed"))).toBe(false);
      expect(isBrowserMissingError(new Error("Resource does not exist"))).toBe(false);
      expect(isBrowserMissingError("Executable doesn't exist at /x")).toBe(false);
      expect(isBrowserMissingError(undefined)).toBe(false);
    });
  });

  describe("fixed message", () => {
    it("contains no path / stack / Call log / error body", () => {
      for (const re of LEAK_PATTERNS) expect(BROWSER_MISSING_MESSAGE).not.toMatch(re);
      expect(BROWSER_MISSING_MESSAGE).not.toContain("║");
    });
    it("does not presume the install directory (R-51)", () => {
      expect(BROWSER_MISSING_MESSAGE).not.toMatch(
        /\binstalled (in|at|under)\b|directory where|cd /i
      );
    });
    it("pins the playwright version so every cwd installs the same revision", () => {
      expect(BROWSER_MISSING_MESSAGE).toContain(
        `npx playwright@${PLAYWRIGHT_PINNED_VERSION} install chromium`
      );
    });
    it("sanitizeErrorMessage returns the fixed message before keyword branches", () => {
      // 'doesn't exist' would otherwise be classified by other keyword branches
      expect(sanitizeErrorMessage(new Error(VARIANT_UPPER))).toBe(BROWSER_MISSING_MESSAGE);
      expect(sanitizeErrorMessage(new Error(VARIANT_LOWER))).toBe(BROWSER_MISSING_MESSAGE);
    });
    it("is idempotent: the fixed message re-sanitizes to itself (INV (b))", () => {
      expect(isBrowserMissingError(new Error(BROWSER_MISSING_MESSAGE))).toBe(true);
      expect(sanitizeErrorMessage(new Error(BROWSER_MISSING_MESSAGE))).toBe(
        BROWSER_MISSING_MESSAGE
      );
    });
    it("--ignore-scripts guidance in README / 01 / 04 is `npm rebuild @prisma/client` (R-18 vi, positive)", () => {
      for (const rel of [
        "apps/mcp-server/README.md",
        "docs/users-guide/01-getting-started.md",
        "docs/users-guide/04-troubleshooting.md",
      ]) {
        expect(readFileSync(path.join(REPO_ROOT, rel), "utf8"), rel).toContain(
          "npm rebuild @prisma/client"
        );
      }
    });
    it("user-facing docs and the fixed message carry no 'npx prisma' (R-18 vi)", () => {
      expect(BROWSER_MISSING_MESSAGE).not.toContain("npx prisma");
      for (const rel of [
        "apps/mcp-server/README.md",
        "docs/users-guide/01-getting-started.md",
        "docs/users-guide/04-troubleshooting.md",
      ]) {
        expect(readFileSync(path.join(REPO_ROOT, rel), "utf8")).not.toContain("npx prisma");
      }
    });
  });

  describe("PLAYWRIGHT_PINNED_VERSION (R-14 (d): three-way agreement)", () => {
    it("equals root devDependencies, mcp-server dependencies and the installed playwright-core", () => {
      const root = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
      const req = createRequire(path.join(PKG_ROOT, "package.json"));
      const installed = JSON.parse(
        readFileSync(
          path.join(path.dirname(req.resolve("playwright-core/package.json")), "package.json"),
          "utf8"
        )
      ).version as string;
      expect(root.devDependencies.playwright).toBe(PLAYWRIGHT_PINNED_VERSION);
      expect(pkg.dependencies.playwright).toBe(PLAYWRIGHT_PINNED_VERSION);
      expect(installed).toBe(PLAYWRIGHT_PINNED_VERSION);
    });
  });

  describe("version notation in user-facing docs (R-59)", () => {
    const DOCS = [
      "README.md",
      "apps/mcp-server/README.md",
      "docs/users-guide/01-getting-started.md",
      "docs/users-guide/04-troubleshooting.md",
    ];
    /**
     * Every `playwright@<ver>` literal (`npx playwright@X`, `npm install playwright@X`) and
     * `gen:ver-playwright` marker value in a text.
     */
    function playwrightVersionsIn(text: string): string[] {
      const out: string[] = [];
      for (const m of text.matchAll(/\bplaywright@(\d+\.\d+\.\d+)/g)) out.push(m[1]!);
      for (const m of text.matchAll(
        /<!-- gen:ver-playwright -->([^<]*)<!-- \/gen:ver-playwright -->/g
      ))
        out.push(m[1]!);
      return out;
    }
    it("the extractor sees a wrong version (gate turns red on drift)", () => {
      expect(playwrightVersionsIn("npx playwright@9.9.9 install chromium")).toEqual(["9.9.9"]);
      expect(
        playwrightVersionsIn("<!-- gen:ver-playwright -->9.9.9<!-- /gen:ver-playwright -->")
      ).toEqual(["9.9.9"]);
    });
    it("the extractor also sees `npm install playwright@X`", () => {
      expect(playwrightVersionsIn("npm install playwright@9.9.9")).toEqual(["9.9.9"]);
    });
    it("every Playwright version in root README / package README / 01 / 04 equals PLAYWRIGHT_PINNED_VERSION", () => {
      let total = 0;
      for (const rel of DOCS) {
        const versions = playwrightVersionsIn(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
        total += versions.length;
        for (const v of versions) expect(v, rel).toBe(PLAYWRIGHT_PINNED_VERSION);
      }
      // README と 04 に各 1 件以上 / at least the README and 04 mentions exist
      expect(total).toBeGreaterThanOrEqual(4);
    });
  });

  describe("real chromium.launch() contract (R-48, no network)", () => {
    it("rejects with the browser-missing error under an empty PLAYWRIGHT_BROWSERS_PATH", () => {
      const empty = mkdtempSync(path.join(os.tmpdir(), "reftrix-empty-browsers-"));
      try {
        const script = `
          const { chromium } = require("playwright");
          (async () => {
            const out = { envPath: process.env.PLAYWRIGHT_BROWSERS_PATH };
            try {
              const b = await chromium.launch({ headless: true });
              await b.close();
              out.launched = true;
            } catch (e) {
              out.launched = false;
              out.message = e && e.message;
            }
            process.stdout.write("RESULT:" + JSON.stringify(out));
          })();`;
        const r = spawnSync(process.execPath, ["-e", script], {
          cwd: PKG_ROOT,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
          encoding: "utf8",
          timeout: 60_000,
        });
        const line = (r.stdout ?? "").split("RESULT:")[1];
        expect(line, `child stderr: ${r.stderr}`).toBeDefined();
        const out = JSON.parse(line!) as { envPath: string; launched: boolean; message?: string };
        // 子 process が空 tmpdir を受け取った / child received the empty tmpdir
        expect(out.envPath).toBe(empty);
        // launch 成功 (browser close 済み) なら fail / a successful launch must fail this test
        expect(out.launched).toBe(false);
        const err = new Error(out.message);
        expect(isBrowserMissingError(err)).toBe(true);
        const client = sanitizeErrorMessage(err);
        expect(client).toBe(BROWSER_MISSING_MESSAGE);
        expect(client).not.toContain(empty);
        for (const re of LEAK_PATTERNS) expect(client).not.toMatch(re);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    }, 90_000);
  });
});
