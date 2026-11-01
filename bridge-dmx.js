// USB protocol shared with the ESP32-C3 bridge; channel 1 starts at byte 3.
export function encodeBridgeDmx(universe) {
  if (universe.length > 512) throw new RangeError('DMX universe exceeds 512 channels');
  const frame = Buffer.alloc(517);
  frame.set([0xa5, 0x5a, 1]);
  frame.set(universe, 3);
  let crc = 0xffff;
  for (const byte of frame.subarray(2, 515)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  frame.writeUInt16LE(crc, 515);
  return frame;
}
