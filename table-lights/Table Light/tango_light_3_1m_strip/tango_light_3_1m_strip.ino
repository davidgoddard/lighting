// Tango Lights - Robust Mesh Lighting System for ESP8266 + NeoPixel
// Author: David Goddard + ChatGPT
// Description: Self-organizing mesh network with master election, sync/freestyle lighting modes, and reliable forwarding.
#include <ESP8266WiFi.h>
#include <espnow.h>
#include <Adafruit_NeoPixel.h>

//-----------------------------------------
// CONFIGURATION
//-----------------------------------------
#define LED_PIN 4  // GPIO4 = D2 on NodeMCU
#define NUM_PIXELS 144
#define MAX_DEVICES 33  // 35 might be too large.
#define FULL_BRIGHTNESS 255
#define SCALED_BRIGHTNESS 0.9

#define HELLO_TIMEOUT 15000   // 15s timeout for neighbor visibility
#define MASTER_TIMEOUT 20000  // 20s without hearing master = elect new one
#define SEEN_MSG_HISTORY 30
#define RANDOM_DELAY_MS 10, 50  // Delay range before forwarding messages
#define LOOP_DELAY_MS 40        // rate of main loop - gives approx 25 frames per second

#define WHITE strip.Color(255, 255, 255)
// RGB animation brightness (HSV 'V'): 0..255
#define RGB_ANIM_V 255      // raise/lower overall RGB intensity

// White-channel cap to limit current: 0..255
#define WHITE_W_MAX 255
// Sweep timing
#define WHITE_SWEEP_DURATION_MS 4000UL

//-----------------------------------------
// ENUMS & STRUCTS
//-----------------------------------------

enum MessageType {
  HELLO = 1,
  IM_MASTER = 2,
  LIGHTS_UP_DOWN = 3
};

struct Neighbour {
  uint8_t mac[6];
  unsigned long lastSeen;
};

struct HelloMessage {
  uint8_t signature;
  uint8_t type;
  unsigned long messageTime;
  uint8_t senderMac[6];
};

struct MasterMessage : public HelloMessage {
  bool syncMode;
  float colour;
  float duration;
  uint8_t numNeighbours;
  uint8_t neighbourhood[MAX_DEVICES][6];
};

struct LightsUpMessage : public HelloMessage {
  bool lightsUp;
};

struct SeenMessage {
  uint8_t senderMac[6];
  unsigned long messageTime;
};

//-----------------------------------------
// QUEUE
//-----------------------------------------

#define MSG_QUEUE_SIZE 10

struct QueuedMessage {
  MasterMessage msg;
  uint8_t senderMac[6];
};

QueuedMessage messageQueue[MSG_QUEUE_SIZE];
volatile int msgHead = 0;
volatile int msgTail = 0;

//-----------------------------------------
// GLOBALS
//-----------------------------------------

Adafruit_NeoPixel strip(NUM_PIXELS, LED_PIN, NEO_GRBW + NEO_KHZ800);

Neighbour neighbours[MAX_DEVICES];
SeenMessage seenMessages[SEEN_MSG_HISTORY];
uint8_t seenPtr = 0;

uint8_t myMac[6];
uint8_t broadcastAddress[] = { 255, 255, 255, 255, 255, 255 };

bool meMaster = false;
bool syncMode = false;
bool lightsUp = false;

unsigned long lastPresenceMessageTime = 0;
unsigned long lastMasterMessageTime = 0;
unsigned long lightsUpDownStart = 0;
unsigned long lastShowTime = 0;
unsigned long nextSyncModeChange = 0;

float currentColorAngle = 0;
float targetColorAngle = 0;
float colorStepPerMs = 0.01;
unsigned long masterDurationTimeout = 0;
float masterColourTarget = 0;

float whiteProgress = 0.0f;     // [0..NUM_PIXELS]


//-----------------------------------------
// UTILS
//-----------------------------------------

String macToString(const uint8_t *mac) {
  char macStr[18];  // Local buffer to hold the MAC address as a string
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(macStr);  // Return a String object to avoid pointer issues
}

bool seenMessage(uint8_t *senderMac, unsigned long messageTime) {
  for (int i = 0; i < SEEN_MSG_HISTORY; i++) {
    if (messageTime == seenMessages[i].messageTime && memcmp(senderMac, seenMessages[i].senderMac, 6) == 0) {
      return true;
    }
  }
  memcpy(seenMessages[seenPtr].senderMac, senderMac, 6);
  seenMessages[seenPtr].messageTime = messageTime;
  seenPtr = (seenPtr + 1) % SEEN_MSG_HISTORY;
  return false;
}

bool isMacInArray(uint8_t *mac) {
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (memcmp(neighbours[i].mac, mac, 6) == 0)
      return true;
  }
  return false;
}

void updateNeighbour(uint8_t *mac, unsigned long timestamp) {
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (memcmp(neighbours[i].mac, mac, 6) == 0) {
      neighbours[i].lastSeen = timestamp;
      return;
    }
    if (neighbours[i].mac[0] == 0x00) {
      memcpy(neighbours[i].mac, mac, 6);
      neighbours[i].lastSeen = timestamp;
      return;
    }
  }
}

void removeOldNeighbours(unsigned long now) {
  for (int i = 0; i < MAX_DEVICES; ++i) {
    if (neighbours[i].mac[0] != 0x00 && (now - neighbours[i].lastSeen) > HELLO_TIMEOUT) {
      memset(neighbours[i].mac, 0, 6);
    }
  }
}

void enqueueMessage(MasterMessage *msg, uint8_t *mac) {
  int nextTail = (msgTail + 1) % MSG_QUEUE_SIZE;
  if (nextTail == msgHead)
    return;  // queue full

  noInterrupts();
  memcpy(&messageQueue[msgTail].msg, msg, sizeof(MasterMessage));
  memcpy(messageQueue[msgTail].senderMac, mac, 6);
  msgTail = nextTail;
  interrupts();
}

// Apply library gamma to 8-bit channel
inline uint8_t g8(Adafruit_NeoPixel &strip, uint8_t x) {
  return strip.gamma8(x);
}

// Given linear 8-bit RGB, apply gamma and scale so (R+G+B)==target_sum.
// Returns packed 24-bit color (no W channel; set W separately if needed).
inline uint32_t pack_const_sum_rgb(Adafruit_NeoPixel &strip,
                                   uint8_t r, uint8_t g, uint8_t b,
                                   uint16_t target_sum) {
  // gamma first, since PWM duty (post-gamma) maps to current
  uint16_t R = g8(strip, r);
  uint16_t G = g8(strip, g);
  uint16_t B = g8(strip, b);

  uint16_t sum = R + G + B;
  if (sum == 0) return strip.Color(0,0,0); // black stays black

  // Scale to target_sum (clamped to 255 per channel)
  const float s = (float)target_sum / (float)sum;
  uint8_t Ro = (uint8_t)constrain(roundf(R * s), 0.0f, 255.0f);
  uint8_t Go = (uint8_t)constrain(roundf(G * s), 0.0f, 255.0f);
  uint8_t Bo = (uint8_t)constrain(roundf(B * s), 0.0f, 255.0f);

  // tiny rounding guard: nudge if we’re off by 1 from the target
  int16_t err = (int16_t)Ro + Go + Bo - (int16_t)target_sum;
  if (err != 0) {
    // subtract/add the error from the largest/smallest channel respectively
    if (err > 0) {
      // reduce the largest
      if (Ro >= Go && Ro >= Bo && Ro >= err) Ro -= err;
      else if (Go >= Bo && Go >= err) Go -= err;
      else if (Bo >= err) Bo -= err;
    } else {
      // boost the smallest
      uint8_t add = (uint8_t)(-err);
      if (Ro <= Go && Ro <= Bo && Ro + add <= 255) Ro += add;
      else if (Go <= Bo && Go + add <= 255) Go += add;
      else if (Bo + add <= 255) Bo += add;
    }
  }

  return strip.Color(Ro, Go, Bo);
}

// HSV -> const-sum RGB (s=255 by default)
inline uint32_t colorHSV_const_sum(Adafruit_NeoPixel &strip,
                                   uint16_t hue16,
                                   uint8_t sat = 255) {
  // Get linear HSV→RGB first (Adafruit_NeoPixel::ColorHSV is linear)
  uint32_t c = Adafruit_NeoPixel::ColorHSV(hue16, sat, 255);
  uint8_t r = (uint8_t)(c >> 16);
  uint8_t g = (uint8_t)(c >> 8);
  uint8_t b = (uint8_t)(c);

  return pack_const_sum_rgb(strip, r, g, b, 255);
}


//-----------------------------------------
// MESSAGES
//-----------------------------------------

void sendHello() {
  HelloMessage msg = { 0xDA, HELLO, millis() };
  memcpy(msg.senderMac, myMac, 6);
  esp_now_send(broadcastAddress, (uint8_t *)&msg, sizeof(msg));
  yield();
  // Serial.printf("Sending Hello message: %lu from me %s\n", msg.messageTime, macToString(msg.senderMac).c_str());
}

void sendImMaster() {
  MasterMessage msg = { 0xDA, IM_MASTER, millis() };
  memcpy(msg.senderMac, myMac, 6);
  msg.syncMode = syncMode;
  msg.colour = masterColourTarget;
  msg.duration = masterDurationTimeout;
  memcpy(msg.neighbourhood[0], myMac, 6);
  msg.numNeighbours = 1;

  for (int i = 0; i < MAX_DEVICES; i++) {
    if (neighbours[i].mac[0] != 0x00) {
      memcpy(msg.neighbourhood[msg.numNeighbours], neighbours[i].mac, 6);
      msg.numNeighbours++;
    }
  }

  esp_now_send(broadcastAddress, (uint8_t *)&msg, sizeof(msg));
  yield();
  // Serial.printf("Sending Master message: %lu from %s: Hue: %.0f Remaining time: %.0f, Sync Mode? %s. Init. Neighbours: %u\n",
  //               msg.messageTime,
  //               macToString(msg.senderMac).c_str(),
  //               msg.colour,
  //               msg.duration,
  //               msg.syncMode ? "Y" : "N",
  //               msg.numNeighbours);
}

bool addUniqueNeighboursToMessage(uint8_t message[][6], uint8_t &count) {
  bool added = false;
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (neighbours[i].mac[0] != 0x00) {
      bool found = false;
      for (int j = 0; j < count; j++) {
        if (memcmp(neighbours[i].mac, message[j], 6) == 0) {
          found = true;
          break;
        }
      }
      if (!found && count < MAX_DEVICES) {
        // Serial.printf("Adding neighbour to message slot %u Mac: %s\n", count, macToString(neighbours[i].mac).c_str());
        memcpy(message[count], neighbours[i].mac, 6);
        // Serial.printf("Done\n");
        count++;
        added = true;
      }
    }
  }
  return added;
}

void printMasterMessage(String label, const MasterMessage &msg) {
  // Print the fields of the MasterMessage structure
  Serial.printf("MasterMessage: %s\n", label.c_str());
  Serial.printf("  Signature: 0x%02X\n", msg.signature);
  Serial.printf("  Type: %d\n", msg.type);
  Serial.printf("  Message Time: %lu\n", msg.messageTime);
  Serial.printf("  Sender MAC: %s\n", macToString(msg.senderMac).c_str());
  Serial.printf("  Sync Mode: %s\n", msg.syncMode ? "Enabled" : "Disabled");
  Serial.printf("  Colour: %.2f\n", msg.colour);
  Serial.printf("  Duration: %.2f\n", msg.duration);
  Serial.printf("  Number of Neighbours: %d\n", msg.numNeighbours);

  // Print the MAC addresses of the neighbours
  Serial.printf("  Neighbours:\n");
  for (int i = 0; i < msg.numNeighbours; i++) {
    Serial.printf("    Neighbour %d MAC: %s\n", i + 1, macToString(msg.neighbourhood[i]).c_str());
  }
}

void forwardMasterMessage(MasterMessage *msg) {
  // printMasterMessage("Before", *msg);
  if (addUniqueNeighboursToMessage(msg->neighbourhood, msg->numNeighbours)) {
    // printMasterMessage("After", *msg);
    delay(random(RANDOM_DELAY_MS));  // Adding a random delay
    esp_now_send(broadcastAddress, (uint8_t *)msg, sizeof(*msg));
  }
}

//-----------------------------------------
// COLOR HANDLING
//-----------------------------------------

float getRandomHue() {
  return static_cast<float>(random(0, 360));
}

float getRandomHueWithThreshold(float current) {
  float newHue;
  do {
    newHue = getRandomHue();
  } while (fabs(newHue - current) < 5.0f);
  return newHue;
}

void setupColorTransition(float targetAngle, float durationMs) {
  if (durationMs <= 0) durationMs = 1;
  targetColorAngle = targetAngle;
  float diff = targetColorAngle - currentColorAngle;
  if (diff > 180)
    diff -= 360;
  else if (diff < -180)
    diff += 360;
  colorStepPerMs = diff / durationMs;
}

uint32_t hslToRgb(float h, float s, float l) {
  float r, g, b;
  auto hue2rgb = [](float p, float q, float t) -> float {
    if (t < 0)
      t += 1;
    if (t > 1)
      t -= 1;
    if (t < 1.0 / 6.0)
      return p + (q - p) * 6 * t;
    if (t < 0.5)
      return q;
    if (t < 2.0 / 3.0)
      return p + (q - p) * (2.0 / 3.0 - t) * 6;
    return p;
  };

  float q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  float p = 2 * l - q;
  r = hue2rgb(p, q, h / 360 + 1.0 / 3.0);
  g = hue2rgb(p, q, h / 360);
  b = hue2rgb(p, q, h / 360 - 1.0 / 3.0);
  return strip.Color(uint8_t(r * 255), uint8_t(g * 255), uint8_t(b * 255));
}

//-----------------------------------------
// setup(), onReceive(), loop() will be implemented here
void becomeMaster() {
  meMaster = true;
  syncMode = false;
  Serial.printf("Becoming master\n");
}

void onReceive(uint8_t *mac, uint8_t *data, uint8_t len) {
  HelloMessage base;
  memcpy(&base, data, sizeof(base));
  if (base.signature != 0xDA)
    return;

  updateNeighbour(base.senderMac, millis());

  if (base.type == IM_MASTER && !seenMessage(base.senderMac, base.messageTime)) {
    if (len >= sizeof(MasterMessage)) {
      MasterMessage msg;
      memcpy(&msg, data, sizeof(MasterMessage));
      enqueueMessage(&msg, base.senderMac);
    }
  }

  // Handle HELLO or LIGHTS_UP_DOWN messages here or queue them too if needed
  if (base.type == LIGHTS_UP_DOWN && len >= sizeof(LightsUpMessage)) {
    LightsUpMessage *lmsg = (LightsUpMessage *)data;
    lightsUp = lmsg->lightsUp;
    lightsUpDownStart = millis();
  }
}

float brightness() {
  float duration = 4.0;
  float elapsed = (millis() - lightsUpDownStart) / 1000.0;
  elapsed = min(elapsed, duration);
  if (lightsUp)
    return 0.5 + (elapsed / duration) * 0.5;
  return 1.0 - (elapsed / duration) * 0.5;
}

void processMessageQueue() {
  while (msgHead != msgTail) {
    QueuedMessage *qm = &messageQueue[msgHead];

    lastMasterMessageTime = millis();

    bool wasInSync = syncMode;
    syncMode = qm->msg.syncMode;

    if (syncMode) {
      setupColorTransition(qm->msg.colour, qm->msg.duration);
      masterDurationTimeout = qm->msg.duration;
    }

    forwardMasterMessage(&qm->msg);
    yield();
    meMaster = false;

    if (wasInSync && !syncMode) {
      masterDurationTimeout = 0;
    }

    msgHead = (msgHead + 1) % MSG_QUEUE_SIZE;
  }
}

void loop() {
  unsigned long now = millis();

  if (Serial.available()) {
    char ch = Serial.read();
    if (ch == '1' || ch == '0') {
      lightsUp = (ch == '1');
      lightsUpDownStart = millis();
      Serial.printf("Using serial port data for now\n");
    } 
  }


  removeOldNeighbours(now);
  processMessageQueue();

  if (!meMaster && now - lastMasterMessageTime > MASTER_TIMEOUT) {
    becomeMaster();
  }

  if (masterDurationTimeout == 0) {
    float hue = getRandomHueWithThreshold(currentColorAngle);
    float dur = random(5000, 25000);
    setupColorTransition(hue, dur);
    masterColourTarget = hue;
    masterDurationTimeout = dur;
    Serial.printf("Selected next colour transiation: Hue %.1f in %.0fms\n", hue, dur);
    if (meMaster) {
      if (now > nextSyncModeChange) {
        syncMode = !syncMode;
        nextSyncModeChange = now + random(30000, 120000);
      }

      sendImMaster();
      lastPresenceMessageTime = now;
    }
  }

  if (masterDurationTimeout > 0) {
    float step = colorStepPerMs * LOOP_DELAY_MS;  // assuming loop runs ~10ms
    currentColorAngle += step;
    if (currentColorAngle >= 360)
      currentColorAngle -= 360;
    if (currentColorAngle < 0)
      currentColorAngle += 360;

    uint16_t hue16 = (uint16_t)((currentColorAngle / 360.0f) * 65535.0f + 0.5f);
    const uint32_t rgb_px   = colorHSV_const_sum(strip, hue16, 255);

    // Advance sweep progress
    float stepPerLoop = (float)NUM_PIXELS * ((float)LOOP_DELAY_MS / (float)WHITE_SWEEP_DURATION_MS);
    if (lightsUp) whiteProgress = min((float)NUM_PIXELS, whiteProgress + stepPerLoop);
    else whiteProgress = max(0.0f, whiteProgress - stepPerLoop);
    int whiteCount = (int)whiteProgress;

    // Render: bottom region = pure W, rest = RGB (W=0)
    for (int i = 0; i < NUM_PIXELS; i++) {
      if (i < whiteCount) {
        strip.setPixelColor(i, 0, 0, 0, WHITE_W_MAX);  // PURE white channel
      } else {
        strip.setPixelColor(i, rgb_px);  // Library maps RGB to your order, W=0
      }
    }
    strip.show();
    yield();
    if (masterDurationTimeout > LOOP_DELAY_MS)
      masterDurationTimeout -= LOOP_DELAY_MS;
    else
      masterDurationTimeout = 0;
  }

  if (now - lastPresenceMessageTime > HELLO_TIMEOUT) {
    if (meMaster)
      sendImMaster();
    else
      sendHello();
    lastPresenceMessageTime = now;
  }

  delay(LOOP_DELAY_MS);
}

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_STA);
  strip.begin();
  strip.setBrightness(FULL_BRIGHTNESS);
  strip.show();
  randomSeed(analogRead(A0));

  if (esp_now_init() != 0)
    return;
  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_register_recv_cb(onReceive);
  esp_now_add_peer(broadcastAddress, ESP_NOW_ROLE_COMBO, 1, NULL, 0);

  WiFi.macAddress(myMac);
  Serial.printf("My Mac address: %s\n", macToString(myMac).c_str());
  lightsUpDownStart = millis();
  lastMasterMessageTime = millis();
}
