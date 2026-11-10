import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";
import usb from "usb";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(process.argv[2] ?? path.join(repository, "config.json"));
const lightingPath = path.join(repository, "lighting.js");
const scanIntervalMs = 2000;
const restartDelayMs = 5000;

const config = JSON.parse(await readFile(configPath, "utf8"));
let lighting = null;
let stopping = false;
let nextStartAt = 0;
let lastScanError = null;
let timer = null;

function usbId(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new Error(`Invalid USB ID: ${value}`);
  }
  return parsed;
}

function directUsbIsSupported() {
  const udmxVendor = usbId(config.usb?.vendorId, "0x16c0");
  const udmxProduct = usbId(config.usb?.productId, "0x05dc");
  const bridgeVendor = usbId(config.externalMaster?.vendorId, "0x1a86");

  return usb.getDeviceList().some(device => {
    const { idVendor, idProduct } = device.deviceDescriptor;
    return (idVendor === udmxVendor && idProduct === udmxProduct) ||
      ((config.externalMaster?.enabled ?? true) && (idVendor === bridgeVendor || idVendor === 0x303a));
  });
}

function serialPortIsSupported(ports) {
  const openDmx = config.openDmx ?? {};
  if (openDmx.enabled) {
    const serialNumbers = [...(openDmx.serialNumbers ?? []), ...(openDmx.serialNumber ? [openDmx.serialNumber] : [])];
    if (ports.some(port => openDmx.path
      ? port.path === openDmx.path
      : serialNumbers.length
        ? serialNumbers.includes(port.serialNumber)
        : port.manufacturer?.toLowerCase().includes("ftdi"))) return true;
  }

  if (!(config.externalMaster?.enabled ?? true)) return false;
  if (config.externalMaster?.path && ports.some(port => port.path === config.externalMaster.path)) return true;

  const bridgeVendor = usbId(config.externalMaster?.vendorId, "0x1a86").toString(16).padStart(4, "0");
  return ports.some(port => ["303a", bridgeVendor].includes(port.vendorId?.toLowerCase()));
}

async function supportedDeviceIsPresent() {
  if (directUsbIsSupported()) return true;
  return serialPortIsSupported(await SerialPort.list());
}

function startLighting() {
  if (lighting || stopping || Date.now() < nextStartAt) return;
  console.log(`Supported USB device detected; starting Lighting with ${configPath}.`);
  lighting = spawn(process.execPath, [lightingPath, configPath], {
    cwd: repository,
    stdio: "inherit"
  });
  lighting.once("error", error => console.error(`Could not start Lighting: ${error.message}`));
  lighting.once("exit", (code, signal) => {
    console.log(`Lighting stopped (${signal ? `signal ${signal}` : `exit ${code}`}).`);
    lighting = null;
    nextStartAt = Date.now() + restartDelayMs;
  });
}

async function scan() {
  if (stopping || lighting) return;
  try {
    if (await supportedDeviceIsPresent()) startLighting();
    lastScanError = null;
  } catch (error) {
    if (error.message !== lastScanError) console.error(`USB scan failed: ${error.message}`);
    lastScanError = error.message;
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (!lighting) process.exit(0);
  lighting.kill(signal);
  lighting.once("exit", () => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

console.log(`Watching for configured Lighting USB devices (configuration: ${configPath}).`);
await scan();
timer = setInterval(scan, scanIntervalMs);

