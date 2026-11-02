// ESP32-C3 combined table-light / DMX bridge. Arduino-ESP32 3.x.
// Native USB CDC On Boot must be enabled. See ../README-esp32-c3.md.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_random.h>
#include "driver/uart.h"
#include "esp_rom_sys.h"

constexpr int DMX_TX_GPIO = 4;
constexpr int DMX_DE_GPIO = 5;
constexpr uint8_t ESPNOW_CHANNEL = 1;
// ESP32-C3 has UART0 and UART1. Native USB CDC remains on USB Serial/JTAG.
constexpr uart_port_t DMX_UART = UART_NUM_1;
constexpr size_t DMX_PACKET_SIZE = 513;
constexpr uint32_t DMX_BAUD = 250000;
constexpr int DMX_BREAK_BITS = 30;  // 120 us BREAK (>= 88 us)
constexpr int DMX_MAB_US = 16;      // Mark-after-break (>= 8 us)

uint8_t universe[DMX_PACKET_SIZE] = {0}; // slot 0 = start code, 1..512 = channels
SemaphoreHandle_t universeMutex;
volatile uint32_t receivedPackets = 0;
volatile uint32_t appliedUsbFrames = 0;
uint32_t rejectedUsbFrames = 0;
uint32_t usbPacketTimeouts = 0;
volatile uint32_t dmxFrames = 0;
bool testMode = false;

uint16_t crc16(const uint8_t *bytes, size_t n) {
  uint16_t c = 0xffff;
  for (size_t i = 0; i < n; i++) {
    c ^= (uint16_t)bytes[i] << 8;
    for (int b = 0; b < 8; b++) c = (c & 0x8000) ? (c << 1) ^ 0x1021 : (c << 1);
  }
  return c;
}

// IDF sends the BREAK *after* the bytes. Thus each iteration emits
// 513 slots followed by the BREAK which begins the *next* DMX frame.
// Waiting 16 us after the BREAK provides the mark-after-break before
// the following 513 slots. The first frame after boot is ignored by
// conforming receivers because it is not preceded by a BREAK.
void dmxTask(void *arg) {
  (void)arg;
  uint8_t local[DMX_PACKET_SIZE] = {0};
  for (;;) {
    if (xSemaphoreTake(universeMutex, portMAX_DELAY) == pdTRUE) {
      memcpy(local, universe, sizeof(local));
      xSemaphoreGive(universeMutex);
    }
    int n = uart_write_bytes_with_break(DMX_UART, local, sizeof(local), DMX_BREAK_BITS);
    esp_err_t done = uart_wait_tx_done(DMX_UART, pdMS_TO_TICKS(100));
    if (n == (int)sizeof(local) && done == ESP_OK) {
      dmxFrames++;
    }
    // The TX line is idle high here, after the hardware BREAK.
    esp_rom_delay_us(DMX_MAB_US);
    // Each 513-slot frame takes ~22.6 ms. UART limits maximum refresh
    // to ~44 fps, regardless of how quickly the USB data arrives.
  }
}

bool initDmxUart() {
  uart_config_t cfg = {};
  cfg.baud_rate = (int)DMX_BAUD;
  cfg.data_bits = UART_DATA_8_BITS;
  cfg.parity = UART_PARITY_DISABLE;
  cfg.stop_bits = UART_STOP_BITS_2;
  cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  cfg.source_clk = UART_SCLK_DEFAULT;
  esp_err_t e = uart_param_config(DMX_UART, &cfg);
  if (e != ESP_OK) return false;
  e = uart_set_pin(DMX_UART, DMX_TX_GPIO, UART_PIN_NO_CHANGE,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
  if (e != ESP_OK) return false;
  e = uart_driver_install(DMX_UART, 256, 0, 0, nullptr, 0);
  return e == ESP_OK;
}

void setAll(uint8_t value) {
  xSemaphoreTake(universeMutex, portMAX_DELAY);
  memset(universe + 1, value, 512);
  xSemaphoreGive(universeMutex);
}

void command(char *line) {
  int ch = 0, val = 0;
  if (!strcmp(line, "HELP")) {
    Serial.println("HELP | STATUS | SET ch val | ALL val | BLACKOUT | TEST ON | TEST OFF");
  } else if (!strcmp(line, "STATUS")) {
    Serial.printf("STATUS dmx_frames=%lu usb_frames=%lu espnow_rx=%lu test=%u channel=%u crc_errors=%lu timeouts=%lu\n",
                  (unsigned long)dmxFrames, (unsigned long)appliedUsbFrames,
                  (unsigned long)receivedPackets, testMode, ESPNOW_CHANNEL,
                  (unsigned long)rejectedUsbFrames, (unsigned long)usbPacketTimeouts);
  } else if (!strcmp(line, "BLACKOUT")) {
    testMode = false; setAll(0); Serial.println("OK BLACKOUT");
  } else if (sscanf(line, "SET %d %d", &ch, &val) == 2 &&
             ch >= 1 && ch <= 512 && val >= 0 && val <= 255) {
    testMode = false;
    xSemaphoreTake(universeMutex, portMAX_DELAY);
    universe[ch] = (uint8_t)val;
    xSemaphoreGive(universeMutex);
    Serial.println("OK SET");
  } else if (sscanf(line, "ALL %d", &val) == 1 && val >= 0 && val <= 255) {
    testMode = false; setAll((uint8_t)val); Serial.println("OK ALL");
  } else if (!strcmp(line, "TEST ON")) {
    testMode = true; Serial.println("OK TEST ON");
  } else if (!strcmp(line, "TEST OFF")) {
    testMode = false; Serial.println("OK TEST OFF");
  } else if (*line) {
    Serial.println("ERR COMMAND");
  }
}

//-----------------------------------------
// CONFIGURATION
//-----------------------------------------
#define MAX_DEVICES 33

// Announce and presence cadence
#define MASTER_ANNOUNCE_INTERVAL_MS 200   // how often we broadcast IM_MASTER
#define HELLO_INTERVAL_MS           2000  // optional presence beacons

// Sync mode toggle (randomized)
#define SYNC_TOGGLE_MIN_MS 30000
#define SYNC_TOGGLE_MAX_MS 120000

// Colour transition ranges (milliseconds)
#define TRANSITION_MIN_MS 5000
#define TRANSITION_MAX_MS 25000

// Housekeeping
#define NEIGHBOUR_TTL_MS 120000

//-----------------------------------------
// PROTOCOL (exactly as original)
//-----------------------------------------

static const uint8_t FRAME_SIG = 0xDA;

enum MessageType : uint8_t {
  HELLO = 1,
  IM_MASTER = 2,
  LIGHTS_UP_DOWN = 3
};

struct Neighbour { uint8_t mac[6]; unsigned long lastSeen; };

struct HelloMessage {
  uint8_t signature;       // 0xDA to identify our frames
  uint8_t type;            // MessageType
  unsigned long messageTime; // millis() at sender
  uint8_t senderMac[6];
};

// EXACT mesh payload (no brightness here)
struct MasterMessage : public HelloMessage {
  bool   syncMode;                       // true: sync followers to colour/duration
  float  colour;                         // hue degrees 0..360
  float  duration;                       // remaining ms for the current transition
  uint8_t numNeighbours;                 // flooding help
  uint8_t neighbourhood[MAX_DEVICES][6];
};

struct LightsUpMessage : public HelloMessage {
  bool lightsUp;                         // true: fade to white + hold; false: return to normal
};

static_assert(sizeof(HelloMessage) == 16, "Legacy HELLO layout");
static_assert(sizeof(MasterMessage) == 228, "Legacy master layout");
static_assert(sizeof(LightsUpMessage) == 20, "Legacy white override layout");
static_assert(__builtin_offsetof(MasterMessage, syncMode) == 16, "Legacy sync offset");
static_assert(__builtin_offsetof(MasterMessage, colour) == 20, "Legacy hue offset");
static_assert(__builtin_offsetof(MasterMessage, duration) == 24, "Legacy duration offset");
static_assert(__builtin_offsetof(MasterMessage, neighbourhood) == 29, "Legacy neighbours offset");
static_assert(__builtin_offsetof(LightsUpMessage, lightsUp) == 16, "Legacy white offset");

//-----------------------------------------
// STATE
//-----------------------------------------

uint8_t myMac[6];
uint8_t broadcastAddress[] = { 255, 255, 255, 255, 255, 255 };

Neighbour neighbours[MAX_DEVICES];

bool staticOverride = false;
bool remoteMasterOverride = false;
float staticHue = 0;
char serialCommand[96];
size_t serialLength = 0;

bool syncMode = false;                 // toggles randomly
float masterColour = 0.0f;             // target hue in degrees
float masterRemainMs = 0.0f;           // remaining ms for the current transition
const uint8_t usbBrightness = 1;     // ONLY for USB printout (not sent over mesh)

// Timers
unsigned long lastAnnounce = 0;
unsigned long lastHello = 0;
unsigned long nextSyncToggle = 0;
unsigned long lastTick = 0;

//-----------------------------------------
// UTILS
//-----------------------------------------

String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

int findNeighbourSlot(const uint8_t *mac) {
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (memcmp(neighbours[i].mac, mac, 6) == 0) return i;
  }
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (neighbours[i].mac[0] == 0x00) return i;
  }
  return -1; // full
}

void updateNeighbour(const uint8_t *mac, unsigned long now) {
  int idx = findNeighbourSlot(mac);
  if (idx < 0) return;
  memcpy(neighbours[idx].mac, mac, 6);
  neighbours[idx].lastSeen = now;
}

void removeOldNeighbours(unsigned long now) {
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (neighbours[i].mac[0] != 0x00 && (now - neighbours[i].lastSeen) > NEIGHBOUR_TTL_MS) {
      memset(neighbours[i].mac, 0x00, 6);
      neighbours[i].lastSeen = 0;
    }
  }
}

//-----------------------------------------
// SENDING
//-----------------------------------------

void sendHello() {
  HelloMessage msg = { FRAME_SIG, (uint8_t)HELLO, millis() };
  memcpy(msg.senderMac, myMac, 6);
  esp_now_send(broadcastAddress, (uint8_t*)&msg, sizeof(msg));
}

void chooseNewTransition() {
  // Pick a new hue sufficiently different from previous (simple jitter-avoid)
  float newHue = (float)random(0, 360);
  if (fabsf(newHue - masterColour) < 30.0f) newHue = fmodf(newHue + 60.0f, 360.0f);
  masterColour = newHue;
  masterRemainMs = (float)random(TRANSITION_MIN_MS, TRANSITION_MAX_MS);
}

void sendImMaster() {
  MasterMessage msg = { FRAME_SIG, (uint8_t)IM_MASTER, millis() };
  memcpy(msg.senderMac, myMac, 6);
  msg.syncMode = staticOverride || remoteMasterOverride ? true : syncMode;
  msg.colour = staticOverride ? staticHue : masterColour;
  msg.duration = staticOverride ? 250.0f : masterRemainMs; // remaining milliseconds (float to match original)

  // Seed neighbourhood with ourselves so followers can add unique neighbours and re-flood
  msg.numNeighbours = 1;
  memcpy(msg.neighbourhood[0], myMac, 6);

  // Optionally include currently known neighbours to accelerate flooding
  for (int i = 0; i < MAX_DEVICES && msg.numNeighbours < MAX_DEVICES; ++i) {
    if (neighbours[i].mac[0] != 0x00) {
      bool dup = false;
      for (uint8_t j = 0; j < msg.numNeighbours; ++j) {
        if (memcmp(msg.neighbourhood[j], neighbours[i].mac, 6) == 0) { dup = true; break; }
      }
      if (!dup) {
        memcpy(msg.neighbourhood[msg.numNeighbours], neighbours[i].mac, 6);
        msg.numNeighbours++;
      }
    }
  }

  esp_now_send(broadcastAddress, (uint8_t*)&msg, sizeof(msg));
}

void sendLightsUpDown(bool up) {
  LightsUpMessage lmsg = { FRAME_SIG, (uint8_t)LIGHTS_UP_DOWN, millis() };
  memcpy(lmsg.senderMac, myMac, 6);
  lmsg.lightsUp = up;

  // Send a few times for robustness (ESP-NOW is best-effort)
  for (int i = 0; i < 3; ++i) {
    esp_now_send(broadcastAddress, (uint8_t*)&lmsg, sizeof(lmsg));
    delay(20);
  }
}

//-----------------------------------------
// RECEIVING
//-----------------------------------------

// WiFi callbacks enqueue only; the Arduino loop owns neighbour state.
QueueHandle_t receivedNeighbours;
void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len < (int)sizeof(HelloMessage) || data[0] != FRAME_SIG) return;
  HelloMessage base;
  memcpy(&base, data, sizeof(base));
  xQueueSend(receivedNeighbours, base.senderMac, 0);
}

//-----------------------------------------
// USB OUTPUT (only on sync-mode transitions)
//-----------------------------------------

void printSyncTuple(uint16_t c, uint32_t d, uint8_t b, bool s) {
  Serial.print("UDP: ");
  Serial.print(c); Serial.print(',');
  Serial.print(d); Serial.print(',');
  Serial.print(b); Serial.print(',');
  Serial.println(s ? F("true") : F("false"));
}

//-----------------------------------------
// SETUP & LOOP
//-----------------------------------------

// Parse whole lines so hue digits never trigger lights-up/down.
void reportTableState() {
  Serial.print(F("TABLE: {\"static\":"));
  Serial.print(staticOverride ? F("true") : F("false"));
  Serial.print(F(",\"master\":"));
  Serial.print(remoteMasterOverride ? F("true") : F("false"));
  Serial.print(F(",\"hue\":"));
  Serial.print(remoteMasterOverride ? masterColour : staticHue);
  Serial.println(F(",\"dmxProtocol\":1}"));
}

void handleSerialCommand() {
  serialCommand[serialLength] = 0;
  if (strcmp(serialCommand, "1") == 0) sendLightsUpDown(true);
  else if (strcmp(serialCommand, "0") == 0) sendLightsUpDown(false);
  else if (strcmp(serialCommand, "BRIDGE?") == 0) reportTableState();
  else if (strcmp(serialCommand, "WANDER") == 0) {
    staticOverride = false;
    remoteMasterOverride = false;
    syncMode = false;
    nextSyncToggle = millis() + random(SYNC_TOGGLE_MIN_MS, SYNC_TOGGLE_MAX_MS);
    sendImMaster();
    printSyncTuple(0, 0, 0, false);
    reportTableState();
  } else if (strncmp(serialCommand, "STATIC ", 7) == 0) {
    char *end;
    float value = strtof(serialCommand + 7, &end);
    if (end == serialCommand + 7 || *end != 0 || !isfinite(value) || value < 0 || value >= 360) return;
    staticHue = value;
    staticOverride = true;
    remoteMasterOverride = false;
    sendImMaster();
    lastAnnounce = millis();
    reportTableState();
  } else if (strncmp(serialCommand, "MASTER ", 7) == 0) {
    char *separator;
    float hue = strtof(serialCommand + 7, &separator);
    if (separator == serialCommand + 7 || *separator != ' ') return;
    char *end;
    float duration = strtof(separator + 1, &end);
    if (*end != 0 || !isfinite(hue) || hue < 0 || hue >= 360 || !isfinite(duration) || duration < 100 || duration > 90000) return;
    staticOverride = false;
    remoteMasterOverride = true;
    syncMode = true;
    masterColour = hue;
    masterRemainMs = duration;
    sendImMaster();
    lastAnnounce = millis();
    reportTableState();
  } else command(serialCommand);
}

// Input parser: fixed 0xA5,0x5A,0x01 header then 512 values and CRC.
// A partial packet times out, allowing recovery from a disconnected app.
uint8_t packet[515];  // type(1), channels(512), crc(2)
size_t packetIndex = 0;
uint8_t state = 0;
unsigned long lastInputMs = 0;
bool lineOverflow = false;

void processByte(uint8_t b) {
  if (state && millis() - lastInputMs > 500) {
    state = 0; packetIndex = 0; usbPacketTimeouts++;
  }
  lastInputMs = millis();
  if (state == 0) {
    if (b == 0xA5) { serialLength = 0; lineOverflow = false; state = 1; return; }
    if (b == '\n' || b == '\r') {
      if (serialLength) { serialCommand[serialLength] = 0; if (!lineOverflow) handleSerialCommand(); serialLength = 0; lineOverflow = false; }
    } else if (b >= 32 && b < 127) {
      if (serialLength < sizeof(serialCommand) - 1) serialCommand[serialLength++] = (char)b;
      else lineOverflow = true;
    }
    return;
  }
  if (state == 1) { state = (b == 0x5A) ? 2 : 0; return; }
  if (state == 2) {
    if (b != 0x01) { state = 0; return; }
    packet[0] = b; packetIndex = 1; state = 3; return;
  }
  packet[packetIndex++] = b;
  if (packetIndex == sizeof(packet)) {
    uint16_t expected = (uint16_t)packet[513] | ((uint16_t)packet[514] << 8);
    if (crc16(packet, 513) == expected) {
      testMode = false;
      xSemaphoreTake(universeMutex, portMAX_DELAY);
      memcpy(universe + 1, packet + 1, 512);
      xSemaphoreGive(universeMutex);
      appliedUsbFrames++;
    } else rejectedUsbFrames++;
    state = 0; packetIndex = 0;
  }
}

void setup() {
  // HWCDC defaults to 256 bytes and drops incoming USB bytes when full.
  // A complete DMX packet is 517 bytes. Allow several packets to queue while
  // the loop handles mesh commands (white override can take about 60 ms).
  // Allocate BEFORE begin(): resizing an active RX queue is not safe.
  if (Serial.setRxBufferSize(4096) != 4096) abort();
  Serial.begin(115200);
  universeMutex = xSemaphoreCreateMutex();
  if (!universeMutex) abort();

  // Both transceivers share TX and driver-enable.
  pinMode(DMX_DE_GPIO, OUTPUT);
  digitalWrite(DMX_DE_GPIO, LOW);  // No line drive during UART setup.
  if (!initDmxUart()) {
    Serial.println("ERR DMX UART init");
    while (true) delay(1000);
  }
  digitalWrite(DMX_DE_GPIO, HIGH);
  if (xTaskCreate(dmxTask, "dmx", 4096, nullptr, 2, nullptr) != pdPASS) {
    Serial.println("ERR DMX task");
    while (true) delay(1000);
  }

  receivedNeighbours = xQueueCreate(16, 6);
  if (!receivedNeighbours) abort();
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  WiFi.setSleep(false);
  ESP_ERROR_CHECK(esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE));
  ESP_ERROR_CHECK(esp_now_init());
  ESP_ERROR_CHECK(esp_now_register_recv_cb(onReceive));
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  peer.channel = ESPNOW_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  ESP_ERROR_CHECK(esp_now_add_peer(&peer));
  WiFi.macAddress(myMac);
  randomSeed(esp_random());
  lastTick = millis();
  nextSyncToggle = millis() + random(SYNC_TOGGLE_MIN_MS, SYNC_TOGGLE_MAX_MS);
  chooseNewTransition();
  reportTableState();
}

void loop() {
  // Bound USB work so continuous traffic cannot starve mesh announcements.
  for (int n = 0; n < 2048 && Serial.available(); ++n) processByte((uint8_t)Serial.read());
  unsigned long now = millis();
  uint8_t sender[6];
  while (xQueueReceive(receivedNeighbours, sender, 0) == pdTRUE) {
    updateNeighbour(sender, now);
    receivedPackets++;
  }
  removeOldNeighbours(now);
  if (testMode) {
    static uint32_t last = 0;
    static uint8_t intensity = 0;
    if (now - last >= 250) { last = now; intensity += 8; setAll(intensity); }
  }

  // Periodic presence HELLO (optional but helps neighbour lists)
  if (now - lastHello >= HELLO_INTERVAL_MS) {
    sendHello();
    lastHello = now;
  }

  // Periodic IM_MASTER announcements (mesh payload unchanged)
  if (now - lastAnnounce >= (staticOverride ? 50 : MASTER_ANNOUNCE_INTERVAL_MS)) {
    sendImMaster();
    lastAnnounce = now;
  }

  // Randomly toggle sync/non-sync
  if (!staticOverride && (int32_t)(now - nextSyncToggle) >= 0) {
    // A host-supplied target follows the bridge's native master session; it
    // must not suppress the scheduled return to autonomous wandering.
    remoteMasterOverride = false;
    syncMode = !syncMode;
    nextSyncToggle = now + random(SYNC_TOGGLE_MIN_MS, SYNC_TOGGLE_MAX_MS);

    if (syncMode) {
      // entering sync: pick a transition and announce
      chooseNewTransition();
      sendImMaster();
      // USB serial output ONLY on switch: <colour> <duration> <brightness> true
      printSyncTuple((uint16_t)masterColour, (uint32_t)masterRemainMs, usbBrightness, true);
    } else {
      // leaving sync: announce (fields stay whatever), and print 0 0 0 false
      sendImMaster();
      printSyncTuple(0, 0, 0, false);
    }
  }

  // When in sync mode, maintain remaining duration countdown so late joiners sync properly
  if (syncMode && !staticOverride) {
    unsigned long dt = now - lastTick;
    if (masterRemainMs > (float)dt) {
      masterRemainMs -= (float)dt;
    } else {
      // Start a fresh transition once previous finished
      if (!remoteMasterOverride) {
        chooseNewTransition();
        // USB serial output ONLY on switch: <colour> <duration> <brightness> true
        printSyncTuple((uint16_t)masterColour, (uint32_t)masterRemainMs, usbBrightness, true);
      } else masterRemainMs = 0;
    }
  }

  lastTick = now;
  delay(1);
}
