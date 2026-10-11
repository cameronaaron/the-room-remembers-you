import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from '../app/page.tsx';
import { allowStyleImports } from './test-doubles/style-imports.ts';

allowStyleImports();
void test('server-rendered home offers entry and privacy information without starting sensors', () => {
  const markup = renderToStaticMarkup(createElement(Home));
  assert.match(markup, /Enter the room/);
  assert.match(markup, /No video is kept/);
  assert.match(markup, /room-generation/);
  assert.doesNotMatch(markup, /the room is remembering how to see/);
});

void test('the root layout declares the language and the installation title', async () => {
  // The title is what an operator sees in the browser tab and in the window
  // list, so it is how a kiosk machine's room is told from its console. The
  // language is what a screen reader pronounces the page in.
  const layout = await import('../app/layout.tsx');
  assert.equal(layout.metadata.title, 'The Room Remembers You');
  assert.match(String(layout.metadata.description), /offline/);
  assert.match(String(layout.metadata.description), /privacy/);

  const markup = renderToStaticMarkup(
    createElement(layout.default, null, createElement('main', { id: 'installation' }, 'room')),
  );
  assert.match(markup, /<html lang="en">/);
  assert.match(markup, /<body>/);
  assert.match(markup, /id="installation"/, 'the layout must render what it is given, not swallow it');
});
