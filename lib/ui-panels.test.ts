import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, useEffect, useState } from 'react';
import { renderToStaticMarkup as staticMarkup } from 'react-dom/server';
import { mount, click, pointerClick, type, act, dom, withMeasuredLayout } from './test-doubles/dom.ts';
import * as Sidebar from '../components/ui/sidebar.tsx';
import * as Calendar from '../components/ui/calendar.tsx';
import * as Carousel from '../components/ui/carousel.tsx';
import * as Chart from '../components/ui/chart.tsx';
import * as Otp from '../components/ui/input-otp.tsx';
import * as Nav from '../components/ui/navigation-menu.tsx';
import * as Scroller from '../components/ui/message-scroller.tsx';
import * as Toast from '../components/ui/toast.tsx';

/**
 * The composite panels: sidebar, calendar, carousel, chart, OTP field,
 * navigation menu, message scroller and toasts.
 *
 * These are the wrappers with state of their own — an open/collapsed sidebar
 * that remembers itself, a chart that hands colours to its series, a toast
 * queue — as opposed to the menus, which mostly forward. What is checked is
 * that their state actually reaches the DOM and the caller, and that the
 * things around them (a keyboard shortcut, a persisted preference, a legend)
 * are wired to it rather than merely present.
 */

const findAll = (selector: string) => [...document.querySelectorAll(selector)];

async function press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }),
    );
  });
}

void test('the sidebar collapses, remembers the choice, and answers its keyboard shortcut', async () => {
  document.cookie = 'sidebar_state=; path=/; max-age=0';
  const view = await mount(h(Sidebar.SidebarProvider, null,
    h(Sidebar.Sidebar, null,
      h(Sidebar.SidebarHeader, null, 'The room'),
      h(Sidebar.SidebarContent, null,
        h(Sidebar.SidebarGroup, null,
          h(Sidebar.SidebarGroupLabel, null, 'Sensing'),
          h(Sidebar.SidebarGroupAction, null, '+'),
          h(Sidebar.SidebarGroupContent, null,
            h(Sidebar.SidebarMenu, null,
              h(Sidebar.SidebarMenuItem, null,
                h(Sidebar.SidebarMenuButton, { isActive: true }, 'Camera'),
                h(Sidebar.SidebarMenuBadge, null, '2'),
                h(Sidebar.SidebarMenuAction, null, '…'),
                h(Sidebar.SidebarMenuSub, null,
                  h(Sidebar.SidebarMenuSubItem, null,
                    h(Sidebar.SidebarMenuSubButton, null, 'Calibration')))))))),
      h(Sidebar.SidebarSeparator, null),
      h(Sidebar.SidebarFooter, null, h(Sidebar.SidebarInput, { 'aria-label': 'Filter' })),
      h(Sidebar.SidebarRail, null)),
    h(Sidebar.SidebarInset, null, h(Sidebar.SidebarTrigger, null))));
  try {
    const panel = view.container.querySelector('[data-slot=sidebar]')!;
    assert.equal(panel.getAttribute('data-state'), 'expanded');
    assert.match(panel.textContent!, /Sensing/);
    assert.match(panel.textContent!, /Calibration/, 'a submenu is part of the panel, not a portal');
    assert.ok(view.container.querySelector('[data-slot=sidebar-menu-button]')?.hasAttribute('data-active'),
      'the page an operator is on must be marked, and CSS reads the attribute, not its value');

    const trigger = view.container.querySelector('[data-slot=sidebar-trigger]')!;
    assert.match(trigger.textContent ?? '', /Toggle Sidebar|^$/);
    await click(trigger);
    assert.equal(view.container.querySelector('[data-slot=sidebar]')?.getAttribute('data-state'), 'collapsed');
    // The choice is written where the server rendering can read it back, so a
    // reload does not throw the operator's layout away.
    assert.match(document.cookie, /sidebar_state=false/);

    // Ctrl/Cmd-B is the shortcut, and it must not also type a "b" into the
    // field an operator may have focused.
    await press('b', { metaKey: true });
    assert.equal(view.container.querySelector('[data-slot=sidebar]')?.getAttribute('data-state'), 'expanded');
    assert.match(document.cookie, /sidebar_state=true/);
    await press('b');
    assert.equal(view.container.querySelector('[data-slot=sidebar]')?.getAttribute('data-state'), 'expanded', 'a bare b must not toggle it');
  } finally { await view.close(); }
});

void test('a controlled sidebar reports every change and never decides for itself', async () => {
  const changes: boolean[] = [];
  function Controlled() {
    const [open, setOpen] = useState(true);
    return h(Sidebar.SidebarProvider, {
      open,
      onOpenChange: (next: boolean) => { changes.push(next); setOpen(next); },
    }, h(Sidebar.Sidebar, { collapsible: 'icon' }, h(Sidebar.SidebarContent, null, 'Panel')),
      h(Sidebar.SidebarTrigger, null));
  }
  const view = await mount(h(Controlled));
  try {
    await click(view.container.querySelector('[data-slot=sidebar-trigger]'));
    await click(view.container.querySelector('[data-slot=sidebar-trigger]'));
    assert.deepEqual(changes, [false, true]);
  } finally { await view.close(); }
});

void test('the sidebar skeleton is decorative and the whole thing works with no provider state', async () => {
  const view = await mount(h(Sidebar.SidebarProvider, { defaultOpen: false },
    h(Sidebar.Sidebar, null, h(Sidebar.SidebarMenu, null,
      h(Sidebar.SidebarMenuItem, null, h(Sidebar.SidebarMenuSkeleton, { showIcon: true }))))));
  try {
    assert.equal(view.container.querySelector('[data-slot=sidebar]')?.getAttribute('data-state'), 'collapsed');
    const skeleton = view.container.querySelector('[data-slot=sidebar-menu-skeleton]')!;
    assert.ok(skeleton, 'a loading menu must still occupy its space');
    assert.equal(skeleton.textContent, '', 'a skeleton must announce nothing');
  } finally { await view.close(); }
});

void test('using a sidebar part outside its provider fails loudly rather than rendering wrong', async () => {
  // Silently rendering an expanded sidebar that no trigger can close is worse
  // than a stack trace during development.
  function Orphan() { Sidebar.useSidebar(); return null; }
  await assert.rejects(async () => { await mount(h(Orphan)); }, /useSidebar/);
});

void test('the calendar shows a month and reports the day that was chosen', async () => {
  let chosen: Date | undefined;
  const view = await mount(h(Calendar.Calendar, {
    mode: 'single',
    defaultMonth: new Date(2026, 8, 1),
    selected: undefined,
    onSelect: (day: Date | undefined) => { chosen = day; },
  }));
  try {
    assert.match(view.container.textContent!, /September 2026/);
    const days = findAll('[data-slot=calendar] button').filter((node) => /^\d+$/.test(node.textContent ?? ''));
    assert.ok(days.length >= 30, `expected a month of days, saw ${days.length}`);
    const fourteenth = days.find((node) => node.textContent === '14')!;
    await click(fourteenth);
    assert.equal(chosen?.getFullYear(), 2026);
    assert.equal(chosen?.getMonth(), 8);
    assert.equal(chosen?.getDate(), 14);
  } finally { await view.close(); }
});

void test('a carousel exposes its own controls and disables the one with nowhere to go', async () => {
  let api: Carousel.CarouselApi | undefined;
  const view = await mount(h(Carousel.Carousel, { setApi: (next: Carousel.CarouselApi) => { api = next; } },
    h(Carousel.CarouselContent, null,
      h(Carousel.CarouselItem, null, 'Day one'),
      h(Carousel.CarouselItem, null, 'Day two')),
    h(Carousel.CarouselPrevious, null),
    h(Carousel.CarouselNext, null)));
  try {
    assert.match(view.container.textContent!, /Day one/);
    assert.match(view.container.textContent!, /Day two/);
    assert.ok(api, 'setApi must hand the caller a way to drive it');
    const previous = view.container.querySelector('[data-slot=carousel-previous]') as HTMLButtonElement;
    const next = view.container.querySelector('[data-slot=carousel-next]') as HTMLButtonElement;
    assert.ok(previous && next);
    // Without measured layout the carousel cannot know it has room to scroll,
    // so both controls are correctly disabled here. What is asserted is that
    // they are bound to that state at all rather than always clickable.
    assert.equal(previous.disabled, true, 'the first slide has nothing before it');
    assert.equal(next.disabled, true);
    assert.equal(view.container.querySelectorAll('[data-slot=carousel-item]').length, 2);
    assert.equal(view.container.querySelector('[data-slot=carousel]')?.getAttribute('role'), 'region');
  } finally { await view.close(); }
});

void test('a chart publishes a colour for every configured series, in both themes', () => {
  // The colours are handed to the series as CSS variables scoped to one chart,
  // which is what lets two charts on a page use the same data keys and still
  // look different. A missing variable renders a series in the browser's
  // default palette, which no assertion about the data would catch.
  const config = {
    ghosts: { label: 'Ghosts', color: '#8f5cff' },
    whispers: { label: 'Whispers', theme: { light: '#ffc440', dark: '#7a5a10' } },
    unpainted: { label: 'Unpainted' },
  } satisfies Chart.ChartConfig;
  const style = staticMarkup(h(Chart.ChartStyle, { id: 'chart-memory', config }));
  assert.ok(style.includes('[data-chart=chart-memory] {'), 'the variables must be scoped to this chart');
  assert.ok(style.includes('--color-ghosts: #8f5cff;'));
  assert.ok(style.includes('--color-whispers: #ffc440;'), 'the light theme colour');
  assert.ok(style.includes('--color-whispers: #7a5a10;'), 'the dark theme colour');
  assert.ok(style.includes('.dark [data-chart=chart-memory]'), 'a dark gallery is the normal case');
  assert.ok(!style.includes('--color-unpainted'), 'a series with no colour declares no variable');

  // No colours at all means no style element, not an empty one.
  assert.equal(staticMarkup(h(Chart.ChartStyle, { id: 'blank', config: { a: { label: 'A' } } })), '');
});


void test('a chart container scopes its identity and passes the caller config down', async () => {
  // The chart body itself is a Recharts ResponsiveContainer, which renders
  // nothing until something has measured it. This fixture has no layout, so
  // what is held here is the container's own contract — its identity and the
  // style block keyed to it. The plotted output is real-browser work.
  const config = { ghosts: { label: 'Ghosts', color: '#8f5cff' } } satisfies Chart.ChartConfig;
  const view = await mount(h(Chart.ChartContainer, { config, id: 'memory', className: 'caller-style', children: h('div', null, 'series') }));
  try {
    const container = view.container.querySelector('[data-slot=chart]')!;
    assert.equal(container.getAttribute('data-chart'), 'chart-memory');
    assert.ok(container.className.includes('caller-style'));
    assert.ok(container.querySelector('style')?.textContent?.includes('--color-ghosts: #8f5cff'));
  } finally { await view.close(); }

  // Two charts with no id given must not collide on one set of variables.
  const first = await mount(h(Chart.ChartContainer, { config, children: h('div', null, 'a') }));
  const second = await mount(h(Chart.ChartContainer, { config, children: h('div', null, 'b') }));
  try {
    const ids = [first, second].map((view) => view.container.querySelector('[data-slot=chart]')!.getAttribute('data-chart'));
    assert.notEqual(ids[0], ids[1], 'two charts sharing an id share a palette');
  } finally { await first.close(); await second.close(); }
});


void test('an OTP field spreads one value across its slots and reports completion once', async () => {
  const completed: string[] = [];
  const view = await mount(h(Otp.InputOTP, {
    maxLength: 6,
    onComplete: (value: string) => { completed.push(value); },
    children: [
      h(Otp.InputOTPGroup, { key: 'first' }, h(Otp.InputOTPSlot, { index: 0 }), h(Otp.InputOTPSlot, { index: 1 }), h(Otp.InputOTPSlot, { index: 2 })),
      h(Otp.InputOTPSeparator, { key: 'gap' }),
      h(Otp.InputOTPGroup, { key: 'second' }, h(Otp.InputOTPSlot, { index: 3 }), h(Otp.InputOTPSlot, { index: 4 }), h(Otp.InputOTPSlot, { index: 5 })),
    ],
  }));
  try {
    const slots = view.container.querySelectorAll('[data-slot=input-otp-slot]');
    assert.equal(slots.length, 6);
    assert.equal(view.container.querySelectorAll('[data-slot=input-otp-separator]').length, 1);
    const field = view.container.querySelector('input') as HTMLInputElement;
    await type(field, '123');
    assert.deepEqual([...view.container.querySelectorAll('[data-slot=input-otp-slot]')].map((node) => node.textContent), ['1', '2', '3', '', '', '']);
    assert.deepEqual(completed, [], 'three digits of six is not a code');
    await type(field, '123456');
    assert.deepEqual(completed, ['123456']);
  } finally { await view.close(); }
});

void test('a navigation menu opens a panel of links and keeps them reachable', async () => {
  const view = await mount(h(Nav.NavigationMenu, null,
    h(Nav.NavigationMenuList, null,
      h(Nav.NavigationMenuItem, null,
        h(Nav.NavigationMenuTrigger, null, 'Docs'),
        h(Nav.NavigationMenuContent, null,
          h(Nav.NavigationMenuLink, { href: '/setup' }, 'Setup'),
          h(Nav.NavigationMenuLink, { href: '/voice' }, 'The voice'))),
      h(Nav.NavigationMenuItem, null, h(Nav.NavigationMenuLink, { href: '/about' }, 'About')))));
  try {
    assert.match(view.container.textContent!, /About/, 'a plain link needs no opening');
    assert.equal(view.container.querySelector('a[href="/about"]')?.getAttribute('data-slot'), 'navigation-menu-link');
    const trigger = view.container.querySelector('[data-slot=navigation-menu-trigger]') as HTMLElement;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const links = findAll('a[href="/setup"], a[href="/voice"]');
    assert.equal(links.length, 2, 'the panel content must reach the document');
    assert.ok(view.container.querySelector('[data-slot=navigation-menu-list]'));
  } finally { await view.close(); }
});

void test('a message scroller holds its items and offers a way back to the newest', async () => {
  const view = await mount(h(Scroller.MessageScrollerProvider, null,
    h(Scroller.MessageScroller, null,
      h(Scroller.MessageScrollerViewport, null,
        h(Scroller.MessageScrollerContent, null,
          h(Scroller.MessageScrollerItem, null, 'you stopped.'),
          h(Scroller.MessageScrollerItem, null, 'you have been here before.'))),
      h(Scroller.MessageScrollerButton, null, 'Latest'))));
  try {
    assert.match(view.container.textContent!, /you stopped\./);
    assert.match(view.container.textContent!, /you have been here before\./);
    assert.equal(view.container.querySelectorAll('[data-slot=message-scroller-item]').length, 2);
    assert.ok(view.container.querySelector('[data-slot=message-scroller-viewport]'));
  } finally { await view.close(); }
});

void test('a toast is queued, shown with its own content, and dismissed', async () => {
  const manager = Toast.createToastManager();
  function Screen() {
    useEffect(() => {
      manager.add({ title: 'Camera lost', description: 'Reconnecting.', type: 'error' });
    }, []);
    return h(Toast.Toaster, { toastManager: manager });
  }
  const view = await mount(h(Toast.ToastProvider, { toastManager: manager }, h(Screen)));
  try {
    const toast = findAll('[data-slot=toast]')[0];
    assert.ok(toast, 'the toast never reached the screen');
    assert.match(toast.textContent!, /Camera lost/);
    assert.match(toast.textContent!, /Reconnecting\./);
    const close = toast.querySelector('[data-slot=toast-close]') as HTMLElement;
    assert.ok(close, 'a toast an operator cannot dismiss will sit over the projection');
    await pointerClick(close);
    assert.equal(findAll('[data-slot=toast]').length, 0);
  } finally { await view.close(); }
});

void test('a chart legend and tooltip use the configured labels and colours, not the raw data keys', async () => {
  // Recharts sizes its plot from a ResizeObserver and renders nothing until one
  // reports, so the legend and the tooltip — the only parts of a chart that
  // carry words — were unreachable. `withMeasuredLayout` answers the observer
  // and nothing else; no position or size is asserted below.
  const config = {
    ghosts: { label: 'Ghosts', color: '#8f5cff' },
    whispers: { label: 'Whispers', color: '#ffc440' },
  } satisfies Chart.ChartConfig;
  await withMeasuredLayout({ width: 480, height: 260 }, async () => {
    const legend = await mount(h(Chart.ChartContainer, {
      config,
      id: 'legend',
      children: h(Chart.ChartLegendContent, {
        payload: [
          { dataKey: 'ghosts', value: 'ghosts', color: '#8f5cff' },
          { dataKey: 'whispers', value: 'whispers', color: '#ffc440' },
          { dataKey: 'hidden', value: 'hidden', color: '#000', type: 'none' },
        ],
      }),
    }));
    try {
      const text = legend.container.textContent ?? '';
      assert.match(text, /Ghosts/, 'the legend must show the configured label, not the data key');
      assert.match(text, /Whispers/);
      assert.doesNotMatch(text, /hidden/, 'a series marked as having no marker is not in the legend');
    } finally { await legend.close(); }

    const tooltip = await mount(h(Chart.ChartContainer, {
      config,
      id: 'tooltip',
      children: h(Chart.ChartTooltipContent, {
        active: true,
        label: 'Tuesday',
        payload: [
          { dataKey: 'ghosts', name: 'ghosts', value: 11, color: '#8f5cff', payload: { day: 'Tuesday' }, graphicalItemId: 'ghosts' },
          { dataKey: 'whispers', name: 'whispers', value: 2, color: '#ffc440', payload: { day: 'Tuesday' }, graphicalItemId: 'whispers' },
        ],
      }),
    }));
    try {
      const text = tooltip.container.textContent ?? '';
      assert.match(text, /Ghosts/);
      assert.match(text, /11/, 'a tooltip that shows no value is a hover with nothing in it');
      assert.match(text, /Whispers/);
      assert.match(text, /2/);
    } finally { await tooltip.close(); }

    // Nothing hovered, nothing to say.
    const idle = await mount(h(Chart.ChartContainer, {
      config,
      id: 'idle',
      children: h(Chart.ChartTooltipContent, { active: false, payload: [] }),
    }));
    try {
      assert.doesNotMatch(idle.container.textContent ?? '', /Ghosts/);
    } finally { await idle.close(); }

    const empty = await mount(h(Chart.ChartContainer, {
      config,
      id: 'empty',
      children: h(Chart.ChartLegendContent, { payload: [] }),
    }));
    try {
      assert.doesNotMatch(empty.container.textContent ?? '', /Ghosts/, 'an empty legend renders nothing, not an empty row');
    } finally { await empty.close(); }
  });
});

void test('vertical carousels route arrow keys to the live scrolling API', async t => {
  let api: Carousel.CarouselApi;
  const view = await mount(h(Carousel.Carousel, { orientation: 'vertical', setApi: value => { api = value; } },
    h(Carousel.CarouselContent, null, h(Carousel.CarouselItem, null, 'First'), h(Carousel.CarouselItem, null, 'Second')),
    h(Carousel.CarouselPrevious), h(Carousel.CarouselNext)));
  try {
    assert.ok(api!);
    const previous = t.mock.method(api!, 'scrollPrev');
    const next = t.mock.method(api!, 'scrollNext');
    const root = view.container.querySelector('[data-slot=carousel]')!;
    for (const key of ['ArrowLeft', 'ArrowRight', 'a']) {
      await act(async () => { root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    }
    assert.equal(previous.mock.callCount(), 1);
    assert.equal(next.mock.callCount(), 1);
    assert.ok(view.container.querySelector('[data-slot=carousel-content] > .flex-col'));
    assert.ok(view.container.querySelector('[data-slot=carousel-item]')?.classList.contains('pt-4'));
    assert.ok(view.container.querySelector('[data-slot=carousel-next]')?.classList.contains('rotate-90'));
  } finally { await view.close(); }
});

void test('carousel controls outside their provider fail explicitly', () => {
  assert.throws(() => staticMarkup(h(Carousel.CarouselPrevious)), /within a <Carousel/);
});
