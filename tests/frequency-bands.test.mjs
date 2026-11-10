import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrumBands } from '../frequency-bands.mjs';
test('FFT bins are partitioned at 20, 250 and 2000 Hz without overlap', () => {
  for (const [hz, expected] of [[10,-1],[20,0],[249,0],[250,1],[1999,1],[2000,2],[5000,2]]) {
    const spectrum = new Float64Array(5501); spectrum[hz] = 11000;
    assert.deepEqual(spectrumBands(spectrum,11000,11000), [0,1,2].map(band => band === expected ? 1 : 0));
  }
});
test('band magnitudes combine squared amplitudes and silent bands remain zero', () => {
  const spectrum = new Float64Array(5501); spectrum[100] = 3; spectrum[200] = 4;
  assert.deepEqual(spectrumBands(spectrum,11000,11000), [5/11000,0,0]);
});
