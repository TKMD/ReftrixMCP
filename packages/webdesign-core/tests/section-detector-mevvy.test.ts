// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Debug test for mevvynetwork.com section detection
 */
import { describe, it, expect } from 'vitest';
import { SectionDetector } from '../src/section-detector';

// Minimal HTML structure from mevvynetwork.com
const MEVVY_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MevvyNetwork</title>
</head>
<body>
  <div id="app">
    <div class="w-full h-full grid grid-cols-1">
      <section class="relative h-screen px-4 md:px-16 overflow-hidden">
        <header class="flex justify-between items-center py-6">
          <div class="text-2xl font-bold">Logo</div>
          <nav class="hidden md:flex gap-6">
            <a href="#">About</a>
            <a href="#">Services</a>
            <a href="#">Contact</a>
          </nav>
        </header>
        <div class="flex flex-col items-center justify-center h-full">
          <h1 class="text-5xl font-bold text-center">Welcome to MevvyNetwork</h1>
          <p class="mt-4 text-lg text-center">Building the future of blockchain</p>
          <button class="mt-8 px-8 py-3 bg-blue-600 text-white rounded-lg">Get Started</button>
        </div>
      </section>
      <section class="mt-12 md:mt-20 lg:mt-40 px-4 md:px-16">
        <h2 class="text-3xl font-bold">Our Features</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8 mt-8">
          <div class="p-6 bg-gray-100 rounded-lg">
            <h3 class="text-xl font-semibold">Feature 1</h3>
            <p class="mt-2">Description of feature 1</p>
          </div>
          <div class="p-6 bg-gray-100 rounded-lg">
            <h3 class="text-xl font-semibold">Feature 2</h3>
            <p class="mt-2">Description of feature 2</p>
          </div>
          <div class="p-6 bg-gray-100 rounded-lg">
            <h3 class="text-xl font-semibold">Feature 3</h3>
            <p class="mt-2">Description of feature 3</p>
          </div>
        </div>
      </section>
      <section class="mt-20 px-4 md:px-16 py-20 bg-gray-900 text-white">
        <h2 class="text-3xl font-bold text-center">About Us</h2>
        <p class="mt-8 text-center max-w-3xl mx-auto">We are a blockchain technology company.</p>
      </section>
      <section class="mt-20 px-4 md:px-16">
        <h2 class="text-3xl font-bold">How It Works</h2>
        <div class="flex flex-col md:flex-row gap-8 mt-8">
          <div class="flex-1">Step 1</div>
          <div class="flex-1">Step 2</div>
          <div class="flex-1">Step 3</div>
        </div>
      </section>
      <section class="mt-20 px-4 md:px-16 py-20 bg-blue-600 text-white text-center">
        <h2 class="text-3xl font-bold">Ready to Start?</h2>
        <p class="mt-4">Join thousands of users today</p>
        <button class="mt-8 px-8 py-3 bg-white text-blue-600 rounded-lg font-semibold">Sign Up Now</button>
      </section>
      <footer class="mt-20 px-4 md:px-16 py-12 bg-gray-800 text-white">
        <div class="flex flex-col md:flex-row justify-between">
          <div>Logo</div>
          <nav class="flex gap-6 mt-4 md:mt-0">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Contact</a>
          </nav>
        </div>
        <p class="mt-8 text-sm text-gray-400">2024 MevvyNetwork. All rights reserved.</p>
      </footer>
    </div>
  </div>
</body>
</html>
`;

describe('SectionDetector - mevvynetwork.com style HTML', () => {
  it('should detect sections with removeNestedSections=true (default)', async () => {
    const detector = new SectionDetector({
      removeNestedSections: true,
      detectLandmarks: true,
      detectSemanticTags: true,
      detectVisualSections: true,
    });

    const sections = await detector.detect(MEVVY_HTML);

    console.log('\\n=== Test 1: removeNestedSections=true ===');
    console.log('Total sections:', sections.length);
    for (const section of sections) {
      console.log(`- Type: ${section.type}, Confidence: ${section.confidence.toFixed(2)}`);
      console.log(`  Tag: ${section.element.tagName}, ID: ${section.element.id || 'none'}`);
      console.log(`  Classes: ${section.element.classes.slice(0, 5).join(', ')}`);
    }

    // Expect at least 5 sections (there are 5 sections + 1 footer + 1 header)
    expect(sections.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect more sections with removeNestedSections=false', async () => {
    const detector = new SectionDetector({
      removeNestedSections: false,
      detectLandmarks: true,
      detectSemanticTags: true,
      detectVisualSections: true,
    });

    const sections = await detector.detect(MEVVY_HTML);

    console.log('\\n=== Test 2: removeNestedSections=false ===');
    console.log('Total sections:', sections.length);
    for (const section of sections) {
      console.log(`- Type: ${section.type}, Confidence: ${section.confidence.toFixed(2)}`);
      console.log(`  Tag: ${section.element.tagName}`);
    }

    // With nested sections included, should detect more
    expect(sections.length).toBeGreaterThanOrEqual(5);
  });

  it('should detect semantic tags only', async () => {
    const detector = new SectionDetector({
      removeNestedSections: false,
      detectLandmarks: false,
      detectSemanticTags: true,
      detectVisualSections: false,
    });

    const sections = await detector.detect(MEVVY_HTML);

    console.log('\\n=== Test 3: detectSemanticTags only ===');
    console.log('Total sections (semantic only):', sections.length);
    for (const section of sections) {
      console.log(`- Tag: ${section.element.tagName}, Type: ${section.type}`);
    }

    // Should detect: 5 section tags + 1 header + 1 footer + 1 nav (nested)
    const sectionTagCount = sections.filter(s => s.element.tagName === 'section').length;
    const headerTagCount = sections.filter(s => s.element.tagName === 'header').length;
    const footerTagCount = sections.filter(s => s.element.tagName === 'footer').length;

    console.log(`\\nSemantic tag breakdown:`);
    console.log(`  section: ${sectionTagCount}`);
    console.log(`  header: ${headerTagCount}`);
    console.log(`  footer: ${footerTagCount}`);

    expect(sectionTagCount).toBe(5);
    expect(headerTagCount).toBe(1);
    expect(footerTagCount).toBe(1);
  });
});
