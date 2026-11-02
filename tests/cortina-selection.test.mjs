import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sync = source.match(/function syncCortinaColourToSelection\(\) \{[^]*?\n\}/)?.[0];
assert.ok(sync, 'cortina selection helper found');

test('multi-select permits a single cortina colour even when paired fixtures or bridge are selected', () => {
  const fixtures = [
    { id: 'a', pairLeaderId: 'a', lightsUpColour: { red:255, green:0, blue:0 } },
    { id: 'b', pairLeaderId: 'a', lightsUpColour: { red:0, green:0, blue:255 } },
    { id: '@table-lights', kind: 'bridge' }
  ];
  let ids=['a','b','@table-lights'];
  const cortinaColourInput = { value:'#00ff44' };
  const applyCortinaColourButton = { disabled:true };
  const context=vm.createContext({ fixtures, selectedIds:()=>ids, cortinaColourInput, applyCortinaColourButton });
  vm.runInContext(`${sync}\nsyncCortinaColourToSelection();`,context);
  assert.equal(applyCortinaColourButton.disabled,false);
  assert.equal(cortinaColourInput.value,'#00ff44', 'preserve operator-selected group colour');
  ids=['@table-lights'];
  vm.runInContext('syncCortinaColourToSelection();',context);
  assert.equal(applyCortinaColourButton.disabled,true, 'no supported DMX lights selected');
});

test('cortina apply explicitly filters bridge but retains paired DMX IDs', () => {
  assert.match(source, /fixture\.kind !== "bridge" && selectedIds\(\)\.includes\(fixture\.id\)/);
  assert.match(source, /fixtureIds: ids,\s*colour: hexToColour\(cortinaColourInput\.value\)/);
});
