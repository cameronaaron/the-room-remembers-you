import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, click, act, dom } from './test-doubles/dom.ts';
import { createElement as h } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.tsx';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/ui/accordion.tsx';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/ui/collapsible.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Toggle } from '../components/ui/toggle.tsx';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.tsx';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group.tsx';
import { Slider } from '../components/ui/slider.tsx';
import { Progress, ProgressLabel, ProgressValue } from '../components/ui/progress.tsx';
import { useIsMobile } from '../hooks/use-mobile.ts';

void test('tabs switch panels and forward vertical orientation to keyboard semantics', async () => {
  for (const orientation of ['horizontal', 'vertical'] as const) {
    const view = await mount(h(Tabs, { defaultValue: 'a', orientation },
      h(TabsList, { variant: 'line' }, h(TabsTrigger, { value: 'a' }, 'A'), h(TabsTrigger, { value: 'b' }, 'B')),
      h(TabsContent, { value: 'a' }, 'First panel'), h(TabsContent, { value: 'b' }, 'Second panel')));
    try {
      const buttons = view.container.querySelectorAll('[role=tab]');
      assert.equal(view.container.querySelector('[role=tablist]')?.getAttribute('aria-orientation') ?? 'horizontal', orientation);
      assert.equal(buttons[0].getAttribute('aria-selected'), 'true');
      await click(buttons[1]);
      assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
      assert.equal(view.container.querySelector('[role=tabpanel]')?.textContent, 'Second panel');
    } finally { await view.close(); }
  }
});
void test('accordion and collapsible disclose their content and report expanded state', async () => {
  for (const accordion of [false, true]) {
    const content = accordion
      ? h(Accordion, null, h(AccordionItem, { value: 'room' }, h(AccordionTrigger, null, 'Details'), h(AccordionContent, null, 'Room details')))
      : h(Collapsible, null, h(CollapsibleTrigger, null, 'Details'), h(CollapsibleContent, null, 'Room details'));
    const view = await mount(content);
    try {
      const trigger = view.container.querySelector('button')!;
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      await click(trigger);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.match(view.container.textContent!, /Room details/);
      await click(trigger);
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    } finally { await view.close(); }
  }
});
void test('checkbox, switch and toggle expose state changes and respect disabled', async () => {
  for (const kind of ['checkbox','switch','toggle'] as const) {
    const changes: boolean[] = [];
    const node = (disabled: boolean) => kind === 'checkbox' ? h(Checkbox, { disabled, onCheckedChange: v => changes.push(v) })
      : kind === 'switch' ? h(Switch, { disabled, size: 'sm', onCheckedChange: v => changes.push(v) })
        : h(Toggle, { disabled, variant: 'outline', size: 'lg', onPressedChange: v => changes.push(v) }, 'Toggle');
    const view = await mount(node(false));
    try {
      const selector = kind === 'toggle' ? 'button' : `[role=${kind}]`;
      await click(view.container.querySelector(selector));
      assert.deepEqual(changes, [true]);
      await view.render(node(true));
      await click(view.container.querySelector(selector));
      assert.deepEqual(changes, [true]);
    } finally { await view.close(); }
  }
});
void test('radio and toggle groups retain values and propagate group styling', async () => {
  const selected: unknown[] = [];
  const view = await mount(h(RadioGroup, { defaultValue: 'a', onValueChange: v => selected.push(v) },
    h(RadioGroupItem, { value: 'a', 'aria-label': 'A' }), h(RadioGroupItem, { value: 'b', 'aria-label': 'B' })));
  try {
    await click(view.container.querySelectorAll('[role=radio]')[1]);
    assert.deepEqual(selected, ['b']);
    for (const variant of [undefined, 'outline'] as const) {
      await view.render(h(ToggleGroup, { key: variant ?? 'default', orientation: 'vertical', variant, size: variant ? 'sm' : undefined, spacing: 0 }, h(ToggleGroupItem, { value: 'a' }, 'A'), h(ToggleGroupItem, { value: 'b' }, 'B')));
      const item = view.container.querySelector('[data-slot=toggle-group-item]')!;
      assert.equal(item.getAttribute('data-variant'), variant ?? 'default');
      await click(item);
      assert.equal(item.getAttribute('aria-pressed'), 'true');
      await act(async () => { (item as HTMLElement).focus(); item.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      assert.equal(document.activeElement, view.container.querySelectorAll('[data-slot=toggle-group-item]')[1]);
    }
  } finally { await view.close(); }
});
void test('sliders represent ranges and progress exposes numeric completion', async () => {
  const view = await mount(h(Slider, { defaultValue: [20, 80] }));
  try {
    assert.deepEqual([...view.container.querySelectorAll('input[type=range]')].map(e => e.getAttribute('aria-valuenow')), ['20','80']);
    await view.render(h(Slider, { key: 'controlled', value: [40], min: 10, max: 50 }));
    assert.equal(view.container.querySelectorAll('input[type=range]').length, 1);
    assert.equal(view.container.querySelector('input[type=range]')?.getAttribute('max'), '50');
    await view.render(h(Progress, { value: 25 }, h(ProgressLabel, null, 'Commissioning'), h(ProgressValue)));
    assert.equal(view.container.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'), '25');
    assert.match(view.container.textContent!, /Commissioning/);
  } finally { await view.close(); }
});
void test('mobile breakpoint reacts to media changes and removes its listener', async t => {
  const media = new dom.window.EventTarget();
  const add = t.mock.method(media, 'addEventListener');
  const remove = t.mock.method(media, 'removeEventListener');
  t.mock.method(dom.window, 'matchMedia', () => media as unknown as MediaQueryList);
  const original = dom.window.innerWidth;
  function Probe() { return h('output', null, useIsMobile() ? 'mobile' : 'desktop'); }
  const view = await mount(h(Probe));
  try {
    for (const [width, expected] of [[767,'mobile'],[768,'desktop']] as const) {
      await act(async () => { Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width }); media.dispatchEvent(new dom.window.Event('change')); });
      assert.equal(view.container.textContent, expected);
    }
  } finally { await view.close(); Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: original }); }
  assert.equal(add.mock.callCount(), 1);
  assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1]);
});
