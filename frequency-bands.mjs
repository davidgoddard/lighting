// RMS-like magnitudes in three disjoint FFT bands. Overall scale cancels when
// each band's track minimum/median/maximum is normalised by the colour director.
export function spectrumBands(spectrum, sampleRate, fftSize) {
  const power = [0, 0, 0];
  for (let bin = 1; bin < spectrum.length; bin++) {
    const hz = bin * sampleRate / fftSize;
    if (hz < 20) continue;
    const band = hz < 250 ? 0 : hz < 2000 ? 1 : 2;
    power[band] += spectrum[bin] ** 2;
  }
  return power.map(value => Math.sqrt(value) / fftSize);
}
