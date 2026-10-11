import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, type ElementType } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import * as Field from '../components/ui/field.tsx';
import * as Pagination from '../components/ui/pagination.tsx';
import * as Breadcrumb from '../components/ui/breadcrumb.tsx';
import * as Attachment from '../components/ui/attachment.tsx';

// These wrappers promise to forward native attributes, classes and escaped
// content. Check that contract for every exported wrapper, including variants.
for (const name of ['card','table','alert','empty','item','kbd','marker','message','bubble','attachment','button-group','badge','breadcrumb','pagination','field','label','skeleton','spinner','separator','aspect-ratio'] as const) {
  void test(`${name} wrappers preserve caller attributes and safely render text`, async () => {
    const primitives = await import(`../components/ui/${name}.tsx`) as Record<string, ElementType>;
    for (const [key, Component] of Object.entries(primitives)) {
      if (!/^[A-Z]/.test(key)) continue;
      const result = html(h(Component, { className: 'caller-style', 'data-probe': key }, '<room & visitor>'));
      assert.ok(result.includes(`data-probe="${key}"`), `${key} dropped native attributes`);
      assert.ok(result.includes('caller-style'), `${key} dropped caller styling`);
      assert.ok(result.includes('&lt;room &amp; visitor&gt;'), `${key} dropped or failed to escape content`);
    }
  });
}
void test('form primitives expose native names, values, disabled state and textarea content', async () => {
  for (const name of ['input','textarea','native-select']) {
    const primitives = await import(`../components/ui/${name}.tsx`) as Record<string, ElementType>;
    const Component = primitives[name === 'input' ? 'Input' : name === 'textarea' ? 'Textarea' : 'NativeSelect'];
    const markup = html(h(Component, { name: 'room', defaultValue: 'hall', disabled: true, 'aria-label': 'Room' }, name === 'native-select' ? h('option', { value: 'hall' }, 'Hall') : undefined));
    assert.match(markup, /name="room"/); assert.match(markup, /disabled/); assert.match(markup, /hall/);
    if (name === 'native-select') {
      assert.match(html(h(primitives.NativeSelectOption, { value: 'a' }, 'A')), /value="a"/);
      assert.match(html(h(primitives.NativeSelectOptGroup, { label: 'Areas' }, h('option', null, 'Hall'))), /label="Areas"/);
    }
  }
});
void test('field errors deduplicate messages and never render undefined errors', () => {
  assert.equal(html(h(Field.FieldError)), '');
  assert.equal(html(h(Field.FieldError, { errors: [] })), '');
  assert.equal(html(h(Field.FieldError, { errors: [undefined] })), '');
  assert.equal(html(h(Field.FieldError, { errors: [{ message: 'Required' }, { message: 'Required' }] })).match(/Required/g)?.length, 1);
  const result = html(h(Field.FieldError, { errors: [{ message: 'A' }, undefined, { message: 'B' }] }));
  assert.equal((result.match(/<li/g) ?? []).length, 2);
  assert.match(result, /role="alert"/);
  assert.match(html(h(Field.FieldError, { errors: [{ message: 'Hidden' }] }, 'Override')), /Override/);
  assert.doesNotMatch(html(h(Field.FieldSeparator)), /field-separator-content/);
});
void test('pagination announces the current page and supplies navigation labels', () => {
  assert.match(html(h(Pagination.PaginationLink, { isActive: true, href: '/2' }, '2')), /aria-current="page"/);
  assert.doesNotMatch(html(h(Pagination.PaginationLink, { isActive: false }, '1')), /aria-current/);
  assert.match(html(h(Pagination.PaginationPrevious)), /Go to previous page/);
  assert.match(html(h(Pagination.PaginationNext, { text: 'Later' })), /Later/);
  assert.match(html(h(Breadcrumb.BreadcrumbSeparator)), /<svg\b/g);
  assert.doesNotMatch(html(h(Breadcrumb.BreadcrumbSeparator, null, '/')), /<svg\b/g);
  assert.match(html(h(Breadcrumb.BreadcrumbPage, null, 'Room')), /aria-current="page"/);
});
void test('attachment triggers avoid accidental form submission and support custom links', () => {
  assert.match(html(h(Attachment.AttachmentTrigger, null, 'Open')), /type="button"/);
  assert.match(html(h(Attachment.AttachmentTrigger, { type: 'submit' }, 'Send')), /type="submit"/);
  const link = html(h(Attachment.AttachmentTrigger, { render: h('a', { href: '/file' }) }, 'Download'));
  assert.match(link, /href="\/file"/); assert.doesNotMatch(link, /type="button"/);
  assert.match(html(h(Attachment.AttachmentAction, { variant: 'outline' }, 'Remove')), /Remove/);
});

void test('ellipsis defaults supply accessible descriptions without caller children', () => {
  for (const [Component, label] of [[Breadcrumb.BreadcrumbEllipsis, 'More'], [Pagination.PaginationEllipsis, 'More pages']] as const) {
    const markup = html(h(Component));
    assert.match(markup, /<svg\b/);
    assert.ok(markup.includes(label));
  }
});
