/*
  ESP32-C3 USB + dual MAX485 DMX test bridge
  -------------------------------------------------
  Requires: Arduino-ESP32 3.x only; NO external DMX library.
  Board: ESP32-C3 with native USB; enable "USB CDC On Boot".

  GPIO4 -> DI on BOTH MAX485 boards
  GPIO5 -> DE on BOTH MAX485 boards
  VBUS/5V -> VCC on BOTH MAX485 boards (only if board exposes USB 5V)
  VBUS/5V -> /RE on BOTH boards (receive disabled)
  GND -> GND on BOTH boards
  RO -> disconnected
  Each MAX485 A/B pair goes to its OWN downstream DMX line.
  WARNING: These are non-isolated outputs. Verify board pinout and DMX polarity.

  Commands via USB serial (115200):
    HELP
    STATUS
    SET <1..512> <0..255>
    BLACKOUT
    ALL <0..255>
    TEST ON
    TEST OFF

  Full-universe binary input (not line-based):
    A5 5A 01 [512 channel bytes] [CRC16-CCITT, little endian]
  CRC is calculated over 0x01 and the 512 channel bytes (poly 0x1021,
  initial 0xFFFF, non-reflected).  No USB reply per frame.

  ESP-NOW: Receives legacy packets on channel 1 and prints diagnostic
  information ONLY (does not interpret or reply; packet definition MUST be
  copied exactly from the original ESP8266 sketch before deployment).
*/

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_arduino_version.h>
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
volatile uint32_t dmxFrames = 0;
bool testMode = false;

// Minimal callback: never block, print, or modify bridge state from WiFi task.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onEspNowReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  (void)info; (void)data; (void)len;
  receivedPackets++;
}
#else
void onEspNowReceive(const uint8_t *mac, const uint8_t *data, int len) {
  (void)mac; (void)data; (void)len;
  receivedPackets++;
}
#endif

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
    Serial.printf("STATUS dmx_frames=%lu usb_frames=%lu espnow_rx=%lu test=%u channel=%u\n",
                  (unsigned long)dmxFrames, (unsigned long)appliedUsbFrames,
                  (unsigned long)receivedPackets, testMode, ESPNOW_CHANNEL);
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

// Input parser: fixed 0xA5,0x5A,0x01 header then 512 values and CRC.
// A partial packet times out, allowing recovery from a disconnected app.
uint8_t packet[515];  // type(1), channels(512), crc(2)
size_t packetIndex = 0;
uint8_t state = 0;
unsigned long lastInputMs = 0;
char lineBuffer[96];
size_t lineLength = 0;

void processByte(uint8_t b) {
  if (state && millis() - lastInputMs > 500) { state = 0; packetIndex = 0; }
  lastInputMs = millis();
  if (state == 0) {
    if (b == 0xA5) { state = 1; return; }
    if (b == '\n' || b == '\r') {
      if (lineLength) { lineBuffer[lineLength] = 0; command(lineBuffer); lineLength = 0; }
    } else if (b >= 32 && b < 127) {
      if (lineLength < sizeof(lineBuffer) - 1) lineBuffer[lineLength++] = (char)b;
      else lineLength = 0;
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
    }
    state = 0; packetIndex = 0;
  }
}

void setup() {
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

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (esp_now_init() == ESP_OK) {
    esp_now_register_recv_cb(onEspNowReceive);
  } else {
    Serial.println("ERR ESP-NOW init");
  }
  Serial.println("ESP32-C3 DMX/USB TEST READY; send HELP");
}

void loop() {
  while (Serial.available()) processByte((uint8_t)Serial.read());
  if (testMode) {
    static uint32_t last = 0;
    static uint8_t intensity = 0;
    if (millis() - last >= 250) {
      last = millis(); intensity += 8;
      setAll(intensity);
    }
  }
  delay(1);
}
