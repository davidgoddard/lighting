import { readFile } from "node:fs/promises";
import process from "node:process";
import { SerialPort } from "serialport";
import usb from "usb";
import { createDmxOutputs, findOpenDmxPort } from "./dmx-outputs.js";

const FPS = 20;
const FRAME_MS = 1000 / FPS;
const START_CHANNEL = 101;
const UDMX_SET_CHANNEL_RANGE = 0x02;
const USB_VENDOR_DEVICE_OUT = 0x40;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const serialAction = action => new Promise((resolve, reject) =>
  action(error => error ? reject(error) : resolve())
);

function parseUsbId(value) {
  return typeof value === "string" ? Number.parseInt(value, 0) : value;
}

function sendUdmxUniverse(device, universe) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(
      USB_VENDOR_DEVICE_OUT,
      UDMX_SET_CHANNEL_RANGE,
      universe.length,
      0,
      universe,
      error => error ? reject(error) : resolve()
    );
  });
}

async function createUdmxTransport(config) {
  const vendorId = parseUsbId(config.usb?.vendorId ?? "0x16c0");
  const productId = parseUsbId(config.usb?.productId ?? "0x05dc");
  const device = usb.findByIds(vendorId, productId);
  if (!device) return null;
  device.open();
  return {
    name: `uDMX ${vendorId.toString(16).padStart(4, "0")}:${productId.toString(16).padStart(4, "0")}`,
    send: universe => sendUdmxUniverse(device, universe),
    close: async () => device.close()
  };
}

async function sendOpenDmxUniverse(port, universe) {
  const frame = Buffer.alloc(universe.length + 1, 0);
  universe.copy(frame, 1);
  await serialAction(done => port.set({ brk: true }, done));
  await wait(1);
  await serialAction(done => port.set({ brk: false }, done));
  await wait(1);
  await serialAction(done => port.write(frame, done));
  await serialAction(done => port.drain(done));
}

async function createOpenDmxTransport(config) {
  if (!config.openDmx?.enabled) return null;
  const ports = await SerialPort.list();
  const match = findOpenDmxPort(ports, config.openDmx);
  if (!match) return null;

  const port = new SerialPort({
    path: match.path,
    baudRate: 250000,
    dataBits: 8,
    stopBits: 2,
    parity: "none",
    autoOpen: false
  });
  await serialAction(done => port.open(done));
  return {
    name: `Open DMX ${match.path}`,
    send: universe => sendOpenDmxUniverse(port, universe),
    close: async () => {
      if (port.isOpen) await serialAction(done => port.close(done));
    }
  };
}

export function configuredUniverseLength(config) {
  return Math.max(START_CHANNEL + 3, ...config.fixtures.map(fixture => {
    const type = config.fixtureTypes[fixture.type];
    if (!type) throw new Error(`Unknown fixture type ${JSON.stringify(fixture.type)}`);
    return fixture.address + type.channelCount - 1;
  }));
}

export function colourFrame(red, green, blue, universeLength = START_CHANNEL + 3) {
  const universe = Buffer.alloc(universeLength, 0);
  universe[START_CHANNEL - 1] = red;
  universe[START_CHANNEL] = green;
  universe[START_CHANNEL + 1] = blue;
  universe[START_CHANNEL + 2] = 0;
  return universe;
}

async function main() {
  const configPath = process.argv[2] ?? "config.json";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const universeLength = configuredUniverseLength(config);
  const outputs = await createDmxOutputs([
    () => createUdmxTransport(config),
    ...(config.openDmx?.enabled ? [() => createOpenDmxTransport(config)] : [])
  ], { retryMs: 500 });
  const colours = [
    ["red", colourFrame(255, 0, 0, universeLength)],
    ["green", colourFrame(0, 255, 0, universeLength)],
    ["blue", colourFrame(0, 0, 255, universeLength)]
  ];
  let stopping = false;

  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`Cycling RGB from DMX channel ${START_CHANNEL} at ${FPS} FPS. Press Ctrl-C to stop.`);
  try {
    while (!stopping) {
      for (const [name, frame] of colours) {
        if (stopping) break;
        console.log(name);
        for (let count = 0; count < FPS && !stopping; count += 1) {
          const startedAt = performance.now();
          await outputs.send(frame);
          await wait(Math.max(0, FRAME_MS - (performance.now() - startedAt)));
        }
      }
    }
  } finally {
    await outputs.send(Buffer.alloc(universeLength, 0));
    await outputs.close();
    console.log("Blackout sent; DMX outputs closed.");
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
