import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const STYLE_PATH = new URL('../../style.css', import.meta.url);
const SURFACE_SELECTORS = [
  '.mnemosyne-panel',
  '.mnemosyne-section',
  '.mnemosyne-action-group',
  '.mnemosyne-panel.mnemosyne-popout-open .mnemosyne-inspector-shell',
  '.mnemosyne-card',
];

function ruleFor(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule for ${selector}`);
  const end = css.indexOf('}', start);
  assert.notEqual(end, -1, `unterminated CSS rule for ${selector}`);
  return css.slice(start, end + 1);
}

test('theme surfaces use SillyTavern\'s real tint variable instead of the undefined background variable', async () => {
  const css = await readFile(STYLE_PATH, 'utf8');

  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(cssWithoutComments, /--SmartThemeBgColor/);
  for (const selector of SURFACE_SELECTORS) {
    const rule = ruleFor(css, selector);
    assert.match(
      rule,
      /background-color:\s*var\(--SmartThemeBlurTintColor,\s*(?:rgb|rgba)\(/,
      `${selector} must have a solid neutral fallback and use SmartThemeBlurTintColor`,
    );
  }
});
