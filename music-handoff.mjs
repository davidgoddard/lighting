// Preserve the displayed hue while moving between independent colour engines.
// A new music track has a reproducible, track-relative trajectory, but must not
// reset the colours that the room was showing before the track began.
export const wrapHue = value => ((value % 360) + 360) % 360;

export function hueOffsets(currentHues, incomingHues) {
  const offsets = {};
  for (const [id, current] of Object.entries(currentHues)) {
    const incoming = incomingHues[id];
    if (Number.isFinite(current) && Number.isFinite(incoming)) {
      offsets[id] = wrapHue(current - incoming);
    }
  }
  return offsets;
}

export function offsetHue(hue, offset = 0) {
  return wrapHue(hue + offset);
}
