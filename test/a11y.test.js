// Accessibility checks (feature 9): simple rules every page must keep.
// These read the HTML/CSS files directly, so they run without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const PAGES = ['index.html', 'grace.html', 'david.html'];

for (const page of PAGES) {
  const html = read(page);

  test(`${page}: has a language, a title and allows zooming`, () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /name="viewport"/);
    assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?![.\d])/, 'never block zoom');
  });

  test(`${page}: every input has a label`, () => {
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    for (const input of inputs) {
      const id = input.match(/\bid="([^"]+)"/)?.[1];
      const hasFor = id && new RegExp(`<label[^>]*for="${id}"`).test(html);
      // or the input sits inside its <label>...</label>
      const wrapped = new RegExp(`<label[^>]*>[^<]*(?:<[^/][^>]*>[^<]*)*${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(html);
      assert.ok(hasFor || wrapped || /aria-label=/.test(input), `input without a label: ${input}`);
    }
  });

  test(`${page}: every button has a name`, () => {
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const text = m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      const idText = /<span id="[^"]+">([^<]+)<\/span>/.test(m[2]);
      assert.ok(text || idText || /aria-label=/.test(m[1]), `button without a name: ${m[0]}`);
    }
  });

  test(`${page}: icons are hidden from screen readers`, () => {
    for (const m of html.matchAll(/<svg\b[^>]*>/g)) assert.match(m[0], /aria-hidden="true"/);
  });
}

for (const page of ['grace.html', 'david.html']) {
  test(`${page}: skip link, one main landmark and a live region`, () => {
    const html = read(page);
    assert.match(html, /<a class="skip-link" href="#main">/);
    assert.equal(html.match(/<main\b/g)?.length, 1);
    assert.match(html, /<main id="main"/);
    assert.match(html, /aria-live="(polite|assertive)"/);
  });
}

// ---- Colour contrast (WCAG 2.2 AA: 4.5:1 for normal text, we aim for AAA 7:1 on Grace's main text) ----

function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const css = read('styles.css');
const v = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

test('contrast: Grace\'s main text is AAA (7:1 or more)', () => {
  assert.ok(contrast(v.text, v.bg) >= 7);
  assert.ok(contrast(v['primary-text'], v.primary) >= 7, 'white on blue buttons');
  assert.ok(contrast(v.muted, v.bg) >= 7, 'grey notes');
});

test('contrast: every coloured message is at least AA (4.5:1)', () => {
  const pairs = [
    ['ok', 'ok-bg'], ['warn', 'warn-bg'], ['bad', 'bad-bg'],
    ['text', 'ok-bg'], ['text', 'warn-bg'], ['text', 'bad-bg'],
    ['ok', 'bg'], ['warn', 'bg'], ['bad', 'bg'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(v[fg], v[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is only ${ratio.toFixed(2)}:1`);
  }
  assert.ok(contrast('#ffffff', v.ok) >= 4.5, 'white on green "Yes" button');
  assert.ok(contrast('#ffffff', v.warn) >= 4.5, 'white on the orange count badge');
});

test('focus outline is thick and visible', () => {
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*6px solid/);
});
