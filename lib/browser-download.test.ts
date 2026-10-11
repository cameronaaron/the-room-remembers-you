import assert from 'node:assert/strict';
import test from 'node:test';
import { dom } from './test-doubles/dom.ts';
import { downloadJson } from './browser-download.ts';

/**
 * A blob URL pins its blob until it is revoked, and this installation runs for
 * twelve hours at a stretch. The leak is invisible in a test that only checks
 * the file came out, so what is asserted here is mostly the cleanup.
 */
function withDownloads<T>(body: (record: {
  created: string[];
  revoked: string[];
  clicks: Array<{ href: string; download: string }>;
  failClick: boolean;
}) => T): T {
  const record = { created: [] as string[], revoked: [] as string[], clicks: [] as Array<{ href: string; download: string }>, failClick: false };
  const w = dom.window as unknown as { URL: typeof URL; Blob: typeof Blob; document: Document };
  // Reached as plain properties: these are being swapped out wholesale, and
  // reading them as methods is what the unbound-method rule exists to stop.
  const urlBag = w.URL as unknown as Record<string, unknown>;
  const documentBag = w.document as unknown as Record<string, unknown>;
  const previous = {
    URL: globalThis.URL, Blob: globalThis.Blob, document: globalThis.document,
    create: urlBag.createObjectURL, revoke: urlBag.revokeObjectURL, element: documentBag.createElement,
  };
  const nativeCreate = previous.element as (this: Document, tag: string) => HTMLElement;

  let issued = 0;
  urlBag.createObjectURL = () => {
    const url = `blob:room/${++issued}`;
    record.created.push(url);
    return url;
  };
  urlBag.revokeObjectURL = (url: string) => { record.revoked.push(url); };
  documentBag.createElement = (tag: string) => {
    const element = nativeCreate.call(w.document, tag) as HTMLAnchorElement;
    if (tag === 'a') {
      element.click = () => {
        record.clicks.push({ href: element.href, download: element.download });
        if (record.failClick) throw new Error('the browser refused the download');
      };
    }
    return element;
  };

  globalThis.URL = w.URL;
  globalThis.Blob = w.Blob;
  globalThis.document = w.document;
  try {
    return body(record);
  } finally {
    urlBag.createObjectURL = previous.create;
    urlBag.revokeObjectURL = previous.revoke;
    documentBag.createElement = previous.element;
    globalThis.URL = previous.URL;
    globalThis.Blob = previous.Blob;
    globalThis.document = previous.document;
  }
}

void test('a download is handed over under the name it was given', () => {
  withDownloads((record) => {
    downloadJson('room-events-2026.json', { kind: 'anonymous-room-events', events: [] });
    assert.equal(record.clicks.length, 1, 'nothing was handed to the browser');
    assert.equal(record.clicks[0].download, 'room-events-2026.json');
    assert.ok(record.clicks[0].href.startsWith('blob:'), 'the link had no blob behind it');
  });
});

void test('the blob url is revoked, and the one that was revoked is the one created', () => {
  withDownloads((record) => {
    downloadJson('a.json', { a: 1 });
    assert.deepEqual(record.revoked, record.created);
    assert.equal(record.created.length, 1);
  });
});

void test('a refused download still releases its blob', () => {
  // The reason the revoke sits in a `finally`. A browser that blocks the click
  // would otherwise pin the blob for the rest of the gallery day, and an
  // operator retrying the export would pin one more each time.
  withDownloads((record) => {
    record.failClick = true;
    assert.throws(() => downloadJson('a.json', { a: 1 }), /refused the download/);
    assert.deepEqual(record.revoked, record.created, 'a blocked download leaked its blob');
  });
});

void test('repeated exports do not accumulate blobs', () => {
  withDownloads((record) => {
    for (let time = 0; time < 5; time += 1) downloadJson(`a-${time}.json`, { time });
    assert.equal(record.created.length, 5);
    assert.deepEqual(record.revoked, record.created);
  });
});
