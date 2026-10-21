// Tango Lights - ESP8266 + NeoPixel (RGBW + HSV-based animation)
// Uses Adafruit ColorHSV() + gamma32() for RGB animation.
// Uses PURE W channel for the sweep. Never unpacks/bitshifts colors.
#include <ESP8266WiFi.h>
#include <espnow.h>
#include <Adafruit_NeoPixel.h>

//-------------------- CONFIG --------------------
#define LED_PIN 4
#define NUM_PIXELS 144
#define LOOP_DELAY_MS 40

// *** SET THIS TO WHAT YOUR TESTER PROVED ***
#define PIXEL_ORDER NEO_GRBW  // e.g. NEO_WRGB, NEO_WGRB, NEO_GRBW, etc.
Adafruit_NeoPixel strip(NUM_PIXELS, LED_PIN, PIXEL_ORDER + NEO_KHZ800);

// Sweep timing
#define WHITE_SWEEP_DURATION_MS 4000UL

// RGB animation brightness (HSV 'V'): 0..255
#define RGB_ANIM_V 255      // raise/lower overall RGB intensity

// White-channel cap to limit current: 0..255
#define WHITE_W_MAX 255

//-------------------- STATE --------------------
float whiteProgress = 0.0f;     // [0..NUM_PIXELS]
bool  lightsUp = false;         // true = fill white bottom->top; false = unfill
float currentHueDeg = 0.0f;     // 0..360
float hueStepPerLoop = 360.0f / (4000.0f / LOOP_DELAY_MS); // full spin each 10s

//-------------------- SETUP --------------------
void setup() {
  Serial.begin(115200);
  strip.begin();
  strip.setBrightness(255);
  strip.clear();
  strip.show();
}

//-------------------- LOOP --------------------
void loop() {
  // Demo hue wheel (replace with your mesh-driven values)
  currentHueDeg += hueStepPerLoop;
  if (currentHueDeg >= 360.0f) currentHueDeg -= 360.0f;

  uint16_t hue16 = (uint16_t)((currentHueDeg / 360.0f) * 65535.0f + 0.5f);
  uint32_t rgbPacked = strip.gamma32(Adafruit_NeoPixel::ColorHSV(hue16, 255, RGB_ANIM_V));

  // Advance sweep progress
  float stepPerLoop = (float)NUM_PIXELS * ((float)LOOP_DELAY_MS / (float)WHITE_SWEEP_DURATION_MS);
  if (lightsUp) whiteProgress = min((float)NUM_PIXELS, whiteProgress + stepPerLoop);
  else          whiteProgress = max(0.0f, whiteProgress - stepPerLoop);
  int whiteCount = (int)whiteProgress;

  // Render: bottom region = pure W, rest = RGB (W=0)
  for (int i=0;i<NUM_PIXELS;i++) {
    if (i < whiteCount) {
      strip.setPixelColor(i, 0,0,0, WHITE_W_MAX);        // PURE white channel
    } else {
      strip.setPixelColor(i, rgbPacked);                 // Library maps RGB to your order, W=0
    }
  }
  strip.show();

  delay(LOOP_DELAY_MS);
}
