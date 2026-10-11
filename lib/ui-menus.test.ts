import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, type ElementType } from 'react';
import { mount, click, pointerClick, type, act, dom } from './test-doubles/dom.ts';

/**
 * The menu family: dropdown, context, menubar, select, command and combobox.
 *
 * Six wrappers around three Base UI primitives, and the reason to test them
 * together is that they share one contract and each re-states it: a trigger
 * that announces what it controls, a portal the caller's items must survive
 * being moved into, selection that actually reaches the caller's handler, and
 * a close that removes the popup rather than leaving it in the accessibility
 * tree. A wrapper that drops `onClick`, `checked` or `value` on the way through
 * renders perfectly and does nothing, which no snapshot would catch.
 *
 * No position, size or animation is asserted: this fixture has no layout.
 */

const findAll = (selector: string) => [...document.querySelectorAll(selector)];
const byText = (selector: string, text: string) => findAll(selector).find((node) => node.textContent === text);

/** Press a key on whatever currently has focus. */
async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
}

for (const [module, prefix] of [['dropdown-menu', 'DropdownMenu'], ['context-menu', 'ContextMenu'], ['menubar', 'Menubar']] as const) {
  void test(`${module} opens a labelled group, runs the caller's handler and closes`, async () => {
    const ui = await import(`../components/ui/${module}.tsx`) as Record<string, ElementType>;
    const chosen: string[] = [];
    const item = (label: string) => h(ui[`${prefix}Item`], { key: label, onClick: () => chosen.push(label) },
      label, h(ui[`${prefix}Shortcut`], null, label[0]));

    // A menubar puts its menus inside a bar; the other two are the menu itself.
    const menu = h(ui[prefix === 'Menubar' ? 'MenubarMenu' : prefix], null,
      h(ui[`${prefix}Trigger`], null, 'Memory'),
      h(ui[`${prefix}Content`], null,
        h(ui[`${prefix}Group`], null,
          h(ui[`${prefix}Label`], null, 'This day'),
          item('Export'),
          h(ui[`${prefix}Separator`], null),
          item('Forget'))));
    const view = await mount(prefix === 'Menubar' ? h(ui.Menubar, null, menu) : menu);

    try {
      assert.equal(findAll('[role=menu]').length, 0, 'nothing is in the document before it is opened');
      const trigger = view.container.querySelector(`[data-slot=${module}-trigger]`) as HTMLElement;
      assert.ok(trigger, 'the menu must have something to open it');

      // A context menu opens on right-click; the other two on a plain one.
      if (prefix === 'ContextMenu') {
        await act(async () => {
          trigger.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, button: 2 }));
        });
      } else {
        await click(trigger);
      }

      const popup = findAll('[role=menu]')[0];
      assert.ok(popup, `${module} did not open`);
      assert.match(popup.textContent!, /This day/, "the caller's label must survive the portal");
      const items = findAll('[role=menuitem]').filter((node) => node !== trigger);
      assert.equal(items.length, 2, `expected two items, saw ${items.map((node) => node.textContent).join(', ')}`);

      await click(byText('[role=menuitem]', 'ExportE')!);
      assert.deepEqual(chosen, ['Export'], 'choosing an item must reach the handler the caller gave');
      assert.equal(findAll('[role=menu]').length, 0, 'choosing must close the menu');
    } finally { await view.close(); }
    assert.equal(findAll('[role=menu]').length, 0, 'unmount must not leave a menu in the document');
  });

  void test(`${module} reports checkbox and radio state back to the caller`, async () => {
    const ui = await import(`../components/ui/${module}.tsx`) as Record<string, ElementType>;
    let blackout = false;
    let surface = 'room';
    const build = () => {
      const menu = h(ui[prefix === 'Menubar' ? 'MenubarMenu' : prefix], { open: true },
        h(ui[`${prefix}Trigger`], null, 'View'),
        h(ui[`${prefix}Content`], null,
          h(ui[`${prefix}CheckboxItem`], { checked: blackout, onCheckedChange: (next: boolean) => { blackout = next; } }, 'Blackout'),
          h(ui[`${prefix}RadioGroup`], { value: surface, onValueChange: (next: string) => { surface = next; } },
            h(ui[`${prefix}RadioItem`], { value: 'room' }, 'Room'),
            h(ui[`${prefix}RadioItem`], { value: 'paper' }, 'Paper'))));
      return prefix === 'Menubar' ? h(ui.Menubar, null, menu) : menu;
    };
    const view = await mount(build());
    try {
      const checkbox = findAll('[role=menuitemcheckbox]')[0];
      assert.equal(checkbox?.getAttribute('aria-checked'), 'false');
      await click(checkbox!);
      assert.equal(blackout, true, 'the checkbox never told the caller');

      const room = byText('[role=menuitemradio]', 'Room')!;
      const paper = byText('[role=menuitemradio]', 'Paper')!;
      assert.equal(room.getAttribute('aria-checked'), 'true', 'the current surface must read as chosen');
      assert.equal(paper.getAttribute('aria-checked'), 'false');
      await click(paper);
      assert.equal(surface, 'paper');
      await view.render(build());
      assert.equal(byText('[role=menuitemradio]', 'Paper')!.getAttribute('aria-checked'), 'true');
    } finally { await view.close(); }
  });
}

void test('a submenu opens from its parent and carries its own items', async () => {
  const ui = await import('../components/ui/dropdown-menu.tsx');
  let exported = '';
  const view = await mount(h(ui.DropdownMenu, { open: true },
    h(ui.DropdownMenuTrigger, null, 'Memory'),
    h(ui.DropdownMenuContent, null,
      h(ui.DropdownMenuSub, null,
        h(ui.DropdownMenuSubTrigger, null, 'Export'),
        h(ui.DropdownMenuSubContent, null,
          h(ui.DropdownMenuItem, { onClick: () => { exported = 'json'; } }, 'Debug log'))))));
  try {
    const subTrigger = findAll('[role=menuitem]').find((node) => node.textContent?.includes('Export'))!;
    assert.equal(subTrigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(subTrigger.getAttribute('aria-expanded'), 'false');
    await act(async () => { (subTrigger as HTMLElement).focus(); });
    await press('ArrowRight');
    const nested = findAll('[role=menuitem]').find((node) => node.textContent === 'Debug log');
    assert.ok(nested, 'the submenu did not open');
    await click(nested!);
    assert.equal(exported, 'json');
  } finally { await view.close(); }
});

void test('a select announces its value, offers its options and reports a change', async () => {
  const ui = await import('../components/ui/select.tsx');
  let chosen = 'FULL';
  // The trigger resolves a value to its label through `items`; without it a
  // select shows the raw stored value, which is the config key, not English.
  const profiles = [{ value: 'FULL', label: 'Full' }, { value: 'CHEAP', label: 'Cheap' }];
  const build = () => h(ui.Select, { value: chosen, items: profiles, onValueChange: (next: unknown) => { chosen = String(next); } },
    h(ui.SelectTrigger, null, h(ui.SelectValue, { placeholder: 'Profile' })),
    h(ui.SelectContent, null,
      h(ui.SelectGroup, null,
        h(ui.SelectLabel, null, 'Hardware profile'),
        h(ui.SelectItem, { value: 'FULL' }, 'Full'),
        h(ui.SelectSeparator, null),
        h(ui.SelectItem, { value: 'CHEAP' }, 'Cheap'))));
  const view = await mount(build());
  try {
    const trigger = view.container.querySelector('[data-slot=select-trigger]') as HTMLElement;
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.match(trigger.textContent!, /Full/, 'the trigger must show what is currently selected');

    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const options = findAll('[role=option]');
    assert.deepEqual(options.map((node) => node.textContent), ['Full', 'Cheap']);
    assert.equal(options[0].getAttribute('aria-selected'), 'true');

    // A listbox option commits on pointerup and swallows the click that
    // follows, so a bare click leaves it looking pressed and says nothing.
    await pointerClick(options[1]);
    assert.equal(chosen, 'CHEAP', 'the select never told the caller');
    await view.render(build());
    assert.match(view.container.querySelector('[data-slot=select-trigger]')!.textContent!, /Cheap/);
  } finally { await view.close(); }
});

void test('the command palette filters to what was typed and says so when nothing matches', async () => {
  const ui = await import('../components/ui/command.tsx');
  const run: string[] = [];
  const view = await mount(h(ui.Command, null,
    h(ui.CommandInput, { placeholder: 'Search' }),
    h(ui.CommandList, null,
      h(ui.CommandEmpty, null, 'Nothing here.'),
      h(ui.CommandGroup, { heading: 'Room' },
        h(ui.CommandItem, { onSelect: () => run.push('blackout') }, 'Blackout',
          h(ui.CommandShortcut, null, 'B')),
        h(ui.CommandSeparator, null),
        h(ui.CommandItem, { onSelect: () => run.push('relearn') }, 'Relearn empty room')))));
  try {
    const input = view.container.querySelector('input') as HTMLInputElement;
    assert.ok(input);
    assert.equal(findAll('[cmdk-item]').length, 2);

    await type(input, 'relearn');
    assert.deepEqual(findAll('[cmdk-item]').map((node) => node.textContent), ['Relearn empty room']);

    await type(input, 'projector');
    assert.equal(findAll('[cmdk-item]').length, 0);
    assert.match(view.container.textContent!, /Nothing here\./, 'an empty result must say so, not show a blank list');

    await type(input, 'black');
    await click(findAll('[cmdk-item]')[0]);
    assert.deepEqual(run, ['blackout']);
  } finally { await view.close(); }
});

void test('a combobox filters its list and hands back the chosen value', async () => {
  const ui = await import('../components/ui/combobox.tsx');
  let chosen: string | null = null;
  const cameras = ['Built-in camera', 'USB camera', 'Capture card'];
  const view = await mount(h(ui.Combobox, {
    items: cameras,
    defaultOpen: true,
    onValueChange: (next: unknown) => { chosen = String(next); },
  },
    h(ui.ComboboxInput, { placeholder: 'Camera' }),
    h(ui.ComboboxContent, null,
      h(ui.ComboboxEmpty, null, 'No camera found.'),
      // The list takes a render function for the filtered items. It goes in
      // `children` rather than as a variadic argument, which createElement
      // types as a node.
      h(ui.ComboboxList, {
        children: (item: string) => h(ui.ComboboxItem, { key: item, value: item }, item),
      }))));
  try {
    const input = view.container.querySelector('input') as HTMLInputElement;
    assert.ok(input);
    assert.deepEqual(findAll('[role=option]').map((node) => node.textContent), cameras);

    await type(input, 'usb');
    assert.deepEqual(findAll('[role=option]').map((node) => node.textContent), ['USB camera'], 'the list must narrow to what was typed');

    await type(input, 'microphone');
    assert.equal(findAll('[role=option]').length, 0);
    assert.match(document.body.textContent!, /No camera found\./, 'an empty list must say why it is empty');

    // Selecting closes the list, so it is done last.
    await type(input, 'usb');
    await pointerClick(findAll('[role=option]')[0]);
    assert.equal(chosen, 'USB camera', 'the combobox never told the caller');
  } finally { await view.close(); }
});

void test('a multi-select combobox shows a chip per choice and each one can be taken back', async () => {
  const ui = await import('../components/ui/combobox.tsx');
  let chosen: string[] = ['USB camera'];
  const cameras = ['Built-in camera', 'USB camera', 'Capture card'];
  const build = () => h(ui.Combobox, {
    items: cameras,
    multiple: true,
    value: chosen,
    onValueChange: (next: unknown) => { chosen = next as string[]; },
  },
    h(ui.ComboboxChips, {
      children: [
        ...chosen.map((camera) => h(ui.ComboboxChip, { key: camera }, camera)),
        h(ui.ComboboxChipsInput, { key: 'field', placeholder: 'Cameras' }),
      ],
    }),
    h(ui.ComboboxContent, null,
      h(ui.ComboboxEmpty, null, 'No camera found.'),
      h(ui.ComboboxList, { children: (item: string) => h(ui.ComboboxItem, { key: item, value: item }, item) })));
  const view = await mount(build());
  try {
    const chips = findAll('[data-slot=combobox-chip]');
    assert.equal(chips.length, 1);
    assert.match(chips[0].textContent!, /USB camera/);
    // Each chip carries its own removal, or a mis-click is unfixable without
    // clearing the whole field.
    const remove = chips[0].querySelector('[data-slot=combobox-chip-remove]') as HTMLElement;
    assert.ok(remove, 'a chip with no way to remove it is a choice that cannot be taken back');
    await click(remove);
    assert.deepEqual(chosen, []);
    await view.render(build());
    assert.equal(findAll('[data-slot=combobox-chip]').length, 0);

    // A chip can also be rendered without its remove control, for a field that
    // is showing a choice rather than offering to change it.
    await view.render(h(ui.Combobox, { items: cameras, multiple: true, value: ['USB camera'] },
      h(ui.ComboboxChips, null, h(ui.ComboboxChip, { showRemove: false }, 'USB camera'))));
    assert.equal(findAll('[data-slot=combobox-chip-remove]').length, 0);
  } finally { await view.close(); }
});

void test('a combobox groups its options under headings and separates them', async () => {
  const ui = await import('../components/ui/combobox.tsx');
  const view = await mount(h(ui.Combobox, { items: ['Ceiling camera', 'Built-in camera'], defaultOpen: true },
    h(ui.ComboboxInput, { placeholder: 'Camera' }),
    h(ui.ComboboxContent, null,
      h(ui.ComboboxGroup, null,
        h(ui.ComboboxLabel, null, 'Mounted'),
        h(ui.ComboboxItem, { value: 'Ceiling camera' }, 'Ceiling camera')),
      h(ui.ComboboxSeparator, null),
      h(ui.ComboboxGroup, null,
        h(ui.ComboboxLabel, null, 'On this machine'),
        h(ui.ComboboxItem, { value: 'Built-in camera' }, 'Built-in camera')))));
  try {
    assert.match(document.body.textContent!, /Mounted/);
    assert.match(document.body.textContent!, /On this machine/);
    assert.equal(findAll('[data-slot=combobox-separator]').length, 1);
    assert.equal(findAll('[role=option]').length, 2);
  } finally { await view.close(); }
});

void test('the command palette can be opened as a dialog, named for a screen reader', async () => {
  const ui = await import('../components/ui/command.tsx');
  const view = await mount(h(ui.CommandDialog, {
    open: true,
    title: 'Room commands',
    description: 'Type to search the console.',
    children: h(ui.Command, null,
      h(ui.CommandInput, { placeholder: 'Search' }),
      h(ui.CommandList, null, h(ui.CommandItem, null, 'Relearn empty room'))),
  }));
  try {
    const dialog = findAll('[role=dialog]')[0];
    assert.ok(dialog, 'the palette must open as a dialog');
    assert.match(document.body.textContent!, /Room commands/, 'a dialog with no name is unusable without sight');
    assert.match(document.body.textContent!, /Type to search the console\./);
    assert.match(dialog.textContent!, /Relearn empty room/);
    // A palette is dismissed with Escape, not with a close button in the corner.
    assert.equal(dialog.querySelectorAll('[data-slot=dialog-close]').length, 0);
  } finally { await view.close(); }
  assert.equal(findAll('[role=dialog]').length, 0);
});

for (const [module, prefix] of [['context-menu', 'ContextMenu'], ['menubar', 'Menubar']] as const) {
  void test(`${module} opens a submenu of its own, in its own portal`, async () => {
    const ui = await import(`../components/ui/${module}.tsx`) as Record<string, ElementType>;
    let exported = '';
    const menu = h(ui[prefix === 'Menubar' ? 'MenubarMenu' : prefix], { open: true },
      h(ui[`${prefix}Trigger`], null, 'Memory'),
      h(ui[`${prefix}Portal`], null,
        h(ui[`${prefix}Content`], null,
          h(ui[`${prefix}Sub`], null,
            h(ui[`${prefix}SubTrigger`], null, 'Export'),
            h(ui[`${prefix}SubContent`], null,
              h(ui[`${prefix}Item`], { onClick: () => { exported = 'json'; } }, 'Debug log'))))));
    const view = await mount(prefix === 'Menubar' ? h(ui.Menubar, null, menu) : menu);
    try {
      const subTrigger = findAll('[role=menuitem]').find((node) => node.textContent?.includes('Export'))!;
      assert.ok(subTrigger, `${module} rendered no submenu trigger`);
      assert.equal(subTrigger.getAttribute('aria-haspopup'), 'menu');
      await act(async () => { (subTrigger as HTMLElement).focus(); });
      await press('ArrowRight');
      const nested = findAll('[role=menuitem]').find((node) => node.textContent === 'Debug log');
      assert.ok(nested, `${module} did not open its submenu`);
      await click(nested!);
      assert.equal(exported, 'json');
    } finally { await view.close(); }
  });
}

void test('an alert dialog can carry an image and its action runs once', async () => {
  const ui = await import('../components/ui/alert-dialog.tsx');
  let resets = 0;
  const view = await mount(h(ui.AlertDialog, { open: true },
    h(ui.AlertDialogContent, null,
      h(ui.AlertDialogMedia, null, h('img', { src: '/wall.png', alt: 'The projection' })),
      h(ui.AlertDialogHeader, null,
        h(ui.AlertDialogTitle, null, 'Let the room forget everything?'),
        h(ui.AlertDialogDescription, null, 'This cannot be undone.')),
      h(ui.AlertDialogFooter, null,
        h(ui.AlertDialogCancel, null, 'Keep memory'),
        h(ui.AlertDialogAction, { variant: 'destructive', onClick: () => { resets += 1; } }, 'Forget everything')))));
  try {
    const dialog = findAll('[role=alertdialog]')[0];
    assert.ok(dialog);
    assert.ok(dialog.querySelector('[data-slot=alert-dialog-media] img'), 'the media slot must render what it is given');
    assert.equal(dialog.querySelector('img')?.getAttribute('alt'), 'The projection');
    const action = [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Forget everything')!;
    await click(action);
    assert.equal(resets, 1, 'a destructive action must run exactly once per press');
  } finally { await view.close(); }
});
