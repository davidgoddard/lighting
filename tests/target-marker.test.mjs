import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = ['trackedFixture','normalizedHue','showTarget','syncWheelToSelection','renderLightsPreservingSelection']
  .map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]).join('\n');

test('card refresh restores ghost target for a selected DMX/table pair', () => {
  let visible = true;
  let inputs = [];
  const fixtures = [
    {id:'dmx', pairLeaderId:'dmx', mode:'wander', hue:60, targetHue:120},
    {id:'@table-lights', kind:'bridge', pairLeaderId:'dmx', mode:'wander', hue:60, targetHue:120}
  ];
  const context = vm.createContext({
    fixtures, dragging:false,
    selectedIds: () => inputs.filter(input => input.checked).map(input => input.value),
    document: {querySelectorAll: () => inputs, documentElement:{style:{setProperty(){}}}},
    targetPointer:{classList:{toggle:(name, on) => { visible=on; }},style:{}},
    setHue(){}, updateSelectionSummary(){},
    renderLights: () => { inputs=fixtures.map(f => ({value:f.id,checked:false})); visible=false; }
  });
  vm.runInContext(functions, context);
  context.renderLightsPreservingSelection(['dmx','@table-lights']);
  assert.equal(visible, true);
  context.renderLightsPreservingSelection(['@table-lights']);
  assert.equal(visible, true, 'selecting only the paired tables still tracks the DMX leader');
  fixtures[0].mode='static';
  context.renderLightsPreservingSelection(['dmx','@table-lights']);
  assert.equal(visible, false, 'static holds correctly have no moving target');
  fixtures[0].mode='wander';
  context.renderLightsPreservingSelection(['dmx','@table-lights']);
  assert.equal(visible, true);
});
