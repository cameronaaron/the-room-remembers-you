import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { mount, click, act } from './test-doubles/dom.ts';
import * as Avatar from '../components/ui/avatar.tsx';
import * as Popover from '../components/ui/popover.tsx';
import * as HoverCard from '../components/ui/hover-card.tsx';
import * as Tooltip from '../components/ui/tooltip.tsx';
import * as ScrollArea from '../components/ui/scroll-area.tsx';
import * as Resizable from '../components/ui/resizable.tsx';
import * as Direction from '../components/ui/direction.tsx';
import * as Drawer from '../components/ui/drawer.tsx';
import * as Collapsible from '../components/ui/collapsible.tsx';

/**
 * The floating and scrolling surfaces.
 *
 * Each of these wraps a primitive that renders somewhere other than where it
 * was written — a portal, a viewport, a panel group — so "it compiles" says
 * nothing about whether the caller's content, labelling and dismissal survive
 * the journey. What is checked here is the part the operator console depends
 * on: that opening reveals the caller's own content, that it is announced, and
 * that closing takes it back out of the document rather than merely hiding it.
 *
 * This fixture does not model layout or the top layer. Nothing below asserts a
 * position, a size, or anything that needs a real compositor.
 */

/** Every element in the document, portals included. */
const findAll = (selector: string) => [...document.querySelectorAll(selector)];

void test('an avatar shows its fallback until its image loads, and counts a group', async () => {
  const view = await mount(h(Avatar.AvatarGroup, null,
    h(Avatar.Avatar, { className: 'caller-style' },
      h(Avatar.AvatarImage, { src: '/operator.png', alt: 'Operator' }),
      h(Avatar.AvatarFallback, null, 'OP'),
      h(Avatar.AvatarBadge, null, '!')),
    h(Avatar.AvatarGroupCount, null, '+3')));
  try {
    // jsdom never loads the image, which is the state a gallery machine with no
    // network is in: the fallback is what is actually on screen.
    assert.match(view.container.textContent!, /OP/);
    assert.match(view.container.textContent!, /\+3/);
    assert.ok(view.container.querySelector('[data-slot=avatar]')?.className.includes('caller-style'), 'caller styling reaches the root');
    assert.ok(view.container.querySelector('[data-slot=avatar-badge]'));
    for (const size of ['sm', 'lg'] as const) {
      await view.render(h(Avatar.Avatar, { size }, h(Avatar.AvatarFallback, null, 'OP')));
      assert.equal(view.container.querySelector('[data-slot=avatar]')?.getAttribute('data-size'), size);
    }
  } finally { await view.close(); }
});

void test('a popover carries the caller content into the portal, named, and takes it back out', async () => {
  const view = await mount(h(Popover.Popover, null,
    h(Popover.PopoverTrigger, null, 'Calibration'),
    h(Popover.PopoverContent, null,
      h(Popover.PopoverHeader, null,
        h(Popover.PopoverTitle, null, 'Four corners'),
        h(Popover.PopoverDescription, null, 'Click each corner of the floor.')))));
  try {
    const trigger = view.container.querySelector('button')!;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(findAll('[data-slot=popover-content]').length, 0, 'nothing is rendered before it is opened');

    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const content = findAll('[data-slot=popover-content]')[0];
    assert.ok(content, 'the popover must reach the document');
    assert.match(content.textContent!, /Four corners/);
    assert.match(content.textContent!, /Click each corner of the floor\./);
    const labelled = document.getElementById(content.getAttribute('aria-labelledby')!);
    assert.equal(labelled?.textContent, 'Four corners', 'the popover is named by its own title');

    // Escape is the only way out for an operator whose hands are on the keyboard.
    await act(async () => {
      trigger.ownerDocument.activeElement?.dispatchEvent(
        new (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally { await view.close(); }
  assert.equal(findAll('[data-slot=popover-content]').length, 0, 'unmount must not leave a portal behind');
});

void test('a hover card and a tooltip render their content only while open', async () => {
  const card = await mount(h(HoverCard.HoverCard, { open: true },
    h(HoverCard.HoverCardTrigger, null, 'Whispers'),
    h(HoverCard.HoverCardContent, null, 'Held in memory only.')));
  try {
    assert.match(document.body.textContent!, /Held in memory only\./);
  } finally { await card.close(); }
  assert.doesNotMatch(document.body.textContent!, /Held in memory only\./);

  const closed = await mount(h(Tooltip.TooltipProvider, null, h(Tooltip.Tooltip, null,
    h(Tooltip.TooltipTrigger, null, 'Blackout'), h(Tooltip.TooltipContent, null, 'Press B'))));
  try {
    assert.doesNotMatch(document.body.textContent!, /Press B/, 'a tooltip is not content, it is an aside');
    await closed.render(h(Tooltip.TooltipProvider, null, h(Tooltip.Tooltip, { open: true },
      h(Tooltip.TooltipTrigger, null, 'Blackout'), h(Tooltip.TooltipContent, null, 'Press B'))));
    assert.match(document.body.textContent!, /Press B/);
  } finally { await closed.close(); }
});

void test('a scroll area puts the caller content inside a scrollable viewport', async () => {
  const view = await mount(h(ScrollArea.ScrollArea, { className: 'caller-style' },
    h('p', null, 'Session log'), h(ScrollArea.ScrollBar, { orientation: 'horizontal' })));
  try {
    const root = view.container.querySelector('[data-slot=scroll-area]')!;
    assert.ok(root.className.includes('caller-style'));
    const viewport = view.container.querySelector('[data-slot=scroll-area-viewport]')!;
    assert.ok(viewport, 'content outside a viewport cannot scroll at all');
    assert.match(viewport.textContent!, /Session log/);
    assert.equal(viewport.getAttribute('tabindex'), '-1', 'the viewport must not be a tab stop of its own');
    // The scrollbar itself is rendered only once there is overflow to report,
    // which needs measured layout. This fixture has none, so its presence is
    // not asserted here — that is real-browser work, not something to fake.
    assert.equal(view.container.querySelector('[data-slot=scroll-area-scrollbar]'), null);
  } finally { await view.close(); }
});

void test('a panel group lays its panels out along the orientation it was given', async () => {
  // The separator runs across the group, so its aria-orientation is the
  // opposite of the group's. Asserting the layout and the separator together is
  // what would catch the orientation being accepted and then dropped — the
  // defect already found in Tabs and ToggleGroup, whose wrappers set a data
  // attribute for CSS and never told the primitive.
  for (const [orientation, flex, separator] of [['horizontal', 'row', 'vertical'], ['vertical', 'column', 'horizontal']] as const) {
    const view = await mount(h(Resizable.ResizablePanelGroup, { orientation },
      h(Resizable.ResizablePanel, { defaultSize: 60 }, 'Projection'),
      h(Resizable.ResizableHandle, { withHandle: true }),
      h(Resizable.ResizablePanel, { defaultSize: 40 }, 'Diagnostics')));
    try {
      const group = view.container.querySelector('[data-slot=resizable-panel-group]') as HTMLElement;
      assert.equal(group.style.flexDirection, flex);
      assert.match(group.textContent!, /Projection/);
      assert.match(group.textContent!, /Diagnostics/);
      const handle = view.container.querySelector('[data-slot=resizable-handle]')!;
      assert.ok(handle, 'a group with no handle cannot be resized');
      assert.equal(handle.getAttribute('aria-orientation'), separator);
      assert.equal(handle.getAttribute('role'), 'separator');
      assert.ok(handle.querySelector('div'), 'withHandle must draw a grip to drag');
    } finally { await view.close(); }
  }
  const plain = await mount(h(Resizable.ResizablePanelGroup, { orientation: 'horizontal' },
    h(Resizable.ResizablePanel, null, 'A'), h(Resizable.ResizableHandle), h(Resizable.ResizablePanel, null, 'B')));
  try {
    assert.equal(plain.container.querySelector('[data-slot=resizable-handle]')!.querySelector('div'), null);
  } finally { await plain.close(); }
});

void test('the direction provider hands its direction to what it wraps', async () => {
  function Reader() {
    return h('span', { 'data-direction': Direction.useDirection() }, 'text');
  }
  for (const direction of ['ltr', 'rtl'] as const) {
    const view = await mount(h(Direction.DirectionProvider, { direction }, h(Reader)));
    try {
      assert.equal(view.container.querySelector('span')?.getAttribute('data-direction'), direction);
    } finally { await view.close(); }
  }
});

void test('a drawer opens an accessible named panel and closes it again', async () => {
  const view = await mount(h(Drawer.Drawer, null,
    h(Drawer.DrawerTrigger, null, 'Open'),
    h(Drawer.DrawerContent, null,
      h(Drawer.DrawerHeader, null,
        h(Drawer.DrawerTitle, null, 'Operator console'),
        h(Drawer.DrawerDescription, null, 'Local controls only.')),
      h(Drawer.DrawerFooter, null, h(Drawer.DrawerClose, null, 'Done')))));
  try {
    assert.equal(findAll('[role=dialog]').length, 0);
    await click(view.container.querySelector('button'));
    const panel = findAll('[role=dialog]')[0];
    assert.ok(panel);
    assert.equal(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent, 'Operator console');
    assert.match(panel.textContent!, /Local controls only\./);
    await click([...panel.querySelectorAll('button')].find((button) => button.textContent === 'Done')!);
    assert.equal(findAll('[role=dialog]').length, 0);
  } finally { await view.close(); }
});

void test('a collapsible section reveals and hides the caller content', async () => {
  const view = await mount(h(Collapsible.Collapsible, null,
    h(Collapsible.CollapsibleTrigger, null, 'Advanced'),
    h(Collapsible.CollapsibleContent, null, h('p', null, 'Scene change limit'))));
  try {
    const trigger = view.container.querySelector('button')!;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.match(view.container.textContent!, /Scene change limit/);
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally { await view.close(); }
});

void test('drawer direction, modality and snap points reach its rendered panel', async () => {
  for (const swipeDirection of ['up', 'left', 'right'] as const) {
    for (const modal of [false, true]) {
      const view = await mount(h(Drawer.Drawer, { open: true, swipeDirection, modal, showSwipeHandle: true, snapPoints: [0.5, 1] },
        h(Drawer.DrawerContent, null, h(Drawer.DrawerTitle, null, 'Controls'), h(Drawer.DrawerDescription, null, 'Settings'))));
      try {
        const panel = document.querySelector('[data-slot=drawer-popup]')!;
        assert.equal(panel.getAttribute('data-swipe-axis'), swipeDirection === 'up' ? 'y' : 'x');
        assert.equal(panel.getAttribute('data-snap-points'), '');
        assert.equal(document.querySelector('[data-slot=drawer-viewport]')?.getAttribute('data-modal'), String(modal));
        assert.equal(!!document.querySelector('[data-slot=drawer-overlay]'), modal);
        assert.equal(panel.querySelector('[data-slot=drawer-swipe-handle]')?.getAttribute('aria-hidden'), 'true');
      } finally { await view.close(); }
    }
  }
});
