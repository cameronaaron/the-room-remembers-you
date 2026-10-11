import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, click } from './test-doubles/dom.ts';
import { createElement as h, type ElementType } from 'react';
import * as Input from '../components/ui/input-group.tsx';

for (const [module, prefix, role] of [['dialog','Dialog','dialog'],['sheet','Sheet','dialog'],['alert-dialog','AlertDialog','alertdialog']] as const) {
  void test(`${module} opens an accessible named overlay, closes and removes its portal`, async () => {
    const ui = await import(`../components/ui/${module}.tsx`) as Record<string, ElementType>;
    const view = await mount(h(ui[prefix], null, h(ui[prefix+'Trigger'], null, 'Open'),
      h(ui[prefix+'Content'], null,
        h(ui[prefix+'Header'], null, h(ui[prefix+'Title'], null, 'Room settings'), h(ui[prefix+'Description'], null, 'Local controls')),
        h(ui[prefix+'Footer'], null, h(ui[prefix === 'AlertDialog' ? prefix+'Cancel' : prefix+'Close'], null, 'Dismiss')))));
    try {
      assert.equal(document.querySelector(`[role=${role}]`), null);
      await click(view.container.querySelector('button'));
      const overlay = document.querySelector(`[role=${role}]`)!;
      assert.ok(overlay);
      const title = document.getElementById(overlay.getAttribute('aria-labelledby')!);
      assert.equal(title?.textContent, 'Room settings');
      assert.match(overlay.textContent!, /Local controls/);
      await click([...overlay.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')!);
      assert.equal(document.querySelector(`[role=${role}]`), null);
    } finally { await view.close(); }
    assert.equal(document.querySelector(`[role=${role}]`), null);
  });
}
void test('input addons focus fields without stealing button focus or submitting forms', async () => {
  let actions = 0;
  const view = await mount(h(Input.InputGroup, null, h(Input.InputGroupInput, { 'aria-label': 'Room' }),
    h(Input.InputGroupAddon, null, h(Input.InputGroupText, null, 'Name'), h(Input.InputGroupButton, { onClick: () => actions++ }, 'Action'))));
  try {
    await click(view.container.querySelector('[data-slot=input-group-addon]'));
    assert.equal(document.activeElement, view.container.querySelector('input'));
    const button = view.container.querySelector('button')!;
    assert.equal(button.type, 'button');
    button.focus(); await click(button); assert.equal(actions, 1); assert.equal(document.activeElement, button);
    await view.render(h(Input.InputGroup, null, h(Input.InputGroupTextarea, { defaultValue: 'Notes' }), h(Input.InputGroupAddon, { align: 'block-end' }, 'Note')));
    await click(view.container.querySelector('[data-slot=input-group-addon]'));
    assert.equal(view.container.querySelector('textarea')?.value, 'Notes');
  } finally { await view.close(); }
});
