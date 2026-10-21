// Master-only Mesh Controller for Tango Table Lights (ESP8266)
// - No NeoPixel code. Only inter-light messaging over ESP-NOW.
// - Always acts as master and regularly announces IM_MASTER.
// - Randomly toggles between sync and non-sync modes.
// - MESH PAYLOAD: EXACTLY matches the original project (no brightness in the mesh).
// - USB UDP reports describe automatic colour targets and sync-mode changes.
// - STATIC <hue> holds the table group (50ms broadcasts, 250ms transitions).
// - WANDER resumes automatic mode; BRIDGE? reports TABLE JSON state.
// - MASTER <hue> <duration-ms> drives a rate-limited music master trajectory.
// - Newline-delimited '1' / '0' retain the existing white override.
//
// Target: ESP8266 boards (NodeMCU, Wemos D1 mini, etc.)

#include <ESP8266WiFi.h>
#include <espnow.h>

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

//-----------------------------------------
// STATE
//-----------------------------------------

uint8_t myMac[6];
uint8_t broadcastAddress[] = { 255, 255, 255, 255, 255, 255 };

Neighbour neighbours[MAX_DEVICES];

bool staticOverride = false;
bool remoteMasterOverride = false;
float staticHue = 0;
char serialCommand[64];
uint8_t serialLength = 0;
bool serialOverflow = false;

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

void onReceive(uint8_t *mac, uint8_t *data, uint8_t len) {
  if (len < sizeof(HelloMessage)) return;

  HelloMessage base;
  memcpy(&base, data, sizeof(base));
  if (base.signature != FRAME_SIG) return; // ignore foreign frames

  updateNeighbour(base.senderMac, millis());

  // Intentionally ignore IM_MASTER from others: this device always acts as master.
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
  Serial.println('}');
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
  }
}

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println();
  Serial.println(F("Master-only Mesh Controller starting"));

  WiFi.mode(WIFI_STA);

  if (esp_now_init() != 0) {
    Serial.println(F("ESP-NOW init failed"));
    return;
  }

  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_register_recv_cb(onReceive);
  esp_now_add_peer(broadcastAddress, ESP_NOW_ROLE_COMBO, 1, NULL, 0); // channel 1 to match lights

  WiFi.macAddress(myMac);
  Serial.print(F("My MAC: "));
  Serial.println(macToString(myMac));

  randomSeed(analogRead(A0));
  lastTick = millis();
  nextSyncToggle = millis() + random(SYNC_TOGGLE_MIN_MS, SYNC_TOGGLE_MAX_MS);
  chooseNewTransition(); // pick an initial (used when syncMode=true)
  reportTableState();
}

void loop() {
  unsigned long now = millis();

  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      if (!serialOverflow) handleSerialCommand();
      serialLength = 0;
      serialOverflow = false;
    } else if (c != '\r') {
      if (serialLength < sizeof(serialCommand) - 1) serialCommand[serialLength++] = c;
      else serialOverflow = true;
    }
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
  if (now >= nextSyncToggle) {
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
  if (syncMode) {
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
  delay(10);
}
