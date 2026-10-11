import { mount, withMeasuredLayout } from './test-doubles/dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartContainer, ChartLegendContent, ChartTooltipContent, ChartStyle, type ChartConfig } from '../components/ui/chart.tsx';

const config: ChartConfig = {
  visitors: { label: 'Visitors', color: '#123456' },
  special: { label: 'Special', icon: () => h('svg', { 'data-icon': 'special' }) },
  value: { label: 'Value' },
};

void test('chart content requires its configuration provider', () => {
  assert.throws(() => renderToStaticMarkup(h(ChartTooltipContent)), /ChartContainer/);
  assert.throws(() => renderToStaticMarkup(h(ChartLegendContent)), /ChartContainer/);
});

void test('chart themes can deliberately leave a theme without a color', () => {
  const markup = renderToStaticMarkup(h(ChartStyle, { id: 'partial', config: { x: { theme: { light: '', dark: '#123456' } } } }));
  assert.equal((markup.match(/--color-x:/g) ?? []).length, 1);
  assert.match(markup, /.dark/);
});

void test('tooltip variants preserve labels, values, formatter arguments and indicator choices', async () => {
  type Props = ComponentProps<typeof ChartTooltipContent>;
  const cases: { props: Props; text: string[]; absent?: string[]; icon?: boolean }[] = [
    { props: { payload: [] }, text: [], absent: ['Visitors'] },
    { props: {}, text: [], absent: ['Visitors'] },
    { props: { hideLabel: true, payload: [{ graphicalItemId: 'series', name: 'visitors', value: 0 }] }, text: ['Visitors', '0'] },
    { props: { label: 'visitors', indicator: 'line', payload: [{ graphicalItemId: 'series', name: 'visitors', value: 'four', payload: { fill: '#abcdef' } }] }, text: ['Visitors', 'four'] },
    { props: { labelKey: 'kind', nameKey: 'kind', indicator: 'dashed', payload: [{ graphicalItemId: 'series', name: 'raw', kind: 'special', value: 2 }] as unknown as Props['payload'] }, text: ['Special', '2'], icon: true },
    { props: { labelKey: 'kind', nameKey: 'kind', payload: [{ graphicalItemId: 'series', value: 3, payload: { kind: 'special' } }] }, text: ['Special', '3'], icon: true },
    { props: { hideIndicator: true, payload: [{ graphicalItemId: 'series', dataKey: 'visitors', value: undefined }] }, text: ['Visitors'] },
    { props: { payload: [{ graphicalItemId: 'series', value: 9 }] }, text: ['Value', '9'] },
    { props: { payload: [{ graphicalItemId: 'series', name: 'unknown', value: 4, payload: null }] }, text: ['unknown', '4'] },
    { props: { label: 'raw label', labelFormatter: (label) => `Day: ${label}`, payload: [{ graphicalItemId: 'series', name: 'visitors', value: 5 }] }, text: ['Day: raw label', '5'] },
    // Recharts types a tooltip value as string | number | (string | number)[],
    // so it reaches a template literal as a union an array can satisfy.
    // Stringifying explicitly says which rendering is being asserted.
    { props: { formatter: (value, name) => `${String(name)}=${String(value)}`, payload: [{ graphicalItemId: 'series', name: 'visitors', value: 6 }] }, text: ['visitors=6'] },
    { props: { formatter: () => 'formatted', payload: [{ graphicalItemId: 'series', name: 'visitors' }, { graphicalItemId: 'series-2', value: 7 }, { graphicalItemId: 'series-3', name: 'hidden', type: 'none' }] }, text: ['Visitors', '7'], absent: ['formatted', 'hidden'] },
    { props: { color: '#987654', payload: [{ graphicalItemId: 'series', name: 'visitors', value: 8 }, { graphicalItemId: 'series-3', name: 'special', value: 9 }] }, text: ['Visitors', 'Special', '8', '9'], icon: true },
  ];
  await withMeasuredLayout({ width: 480, height: 260 }, async () => {
    for (const item of cases) {
      const view = await mount(h(ChartContainer, { config, children: h(ChartTooltipContent, { active: true, ...item.props }) }));
      try {
        const text = view.container.textContent!;
        for (const value of item.text) assert.ok(text.includes(value), `${JSON.stringify(item.props)} lacks ${value}: ${text}`);
        for (const value of item.absent ?? []) assert.ok(!text.includes(value));
        if (item.icon) assert.ok(view.container.querySelector('[data-icon=special]'));
        if (item.props.hideIndicator) assert.equal(view.container.querySelector('[style*="--color-bg"]'), null);
        if (item.props.indicator === 'dashed' && !item.icon) assert.ok(view.container.querySelector('.border-dashed'));
      } finally { await view.close(); }
    }
  });
});

void test('legend resolves nested series names and honors icon visibility and alignment', async () => {
  await withMeasuredLayout({ width: 480, height: 260 }, async () => {
    for (const hideIcon of [false, true]) {
      const view = await mount(h(ChartContainer, { config, children: h(ChartLegendContent, {
        hideIcon, verticalAlign: 'top', nameKey: 'kind',
        payload: [{ value: 'raw', payload: { kind: 'special' }, color: '#123456' }],
      }) }));
      try {
        assert.match(view.container.textContent!, /Special/);
        assert.equal(!!view.container.querySelector('[data-icon=special]'), !hideIcon);
        assert.ok(view.container.querySelector('.pb-3'));
      } finally { await view.close(); }
    }
    const view = await mount(h(ChartContainer, { config, children: h(ChartLegendContent, { payload: [{ value: 'raw' }] }) }));
    try { assert.match(view.container.textContent!, /Value/); } finally { await view.close(); }
  });
});
