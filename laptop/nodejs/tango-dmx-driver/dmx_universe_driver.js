/*
** A DMX light controller



*/

var usb = require("usb");

var socketIO = require("socket.io-client")("http://tandaplayerbt.local:80"); // This is a client connecting to the SERVER 2
let dmx;

class DMX {
  constructor(frameRate, options = null, nextFrameCallback) {
    let defaults = {
      vendor: 0x16c0,
      device: 0x5dc,
    };

    for (var opt in defaults) {
      if (!defaults.hasOwnProperty(opt)) continue;
      this[opt] =
        options && options.hasOwnProperty(opt) ? options[opt] : defaults[opt];
    }

    this.connected = false;
    this._state = [];
    this._frameRate = frameRate;

    let self = this;
    this._refresh = () => {
      nextFrameCallback(self);
      setTimeout(self._refresh, (1 / self._frameRate) * 1000);
    };

    this.connect();
  }

  frameRate(rate) {
    this._frameRate = rate;
  }

  connect() {
    this.dev = usb.findByIds(this.vendor, this.device);
    console.log(this.vendor, this.device, this.dev)
    if (this.dev === undefined) {
      throw "Unable to find USB device!";
    }
    this.connected = true;

    this.dev.open();
    for (var i = 1; i <= 512; i++) {
      this._state[i] = 0;
      this.setChannel(i, 0);
    }
    this._refresh();
  }

  setChannel(c, v) {
    let self = this;
    try {
      // if ( self._state[c] != v ){
      self.dev.controlTransfer(
        64,
        1,
        v,
        c - 1,
        Buffer.from([1]),
        function (err, result) {
          if (err) {
            throw err;
            return;
          }
          // console.log(c-1, v)
        }
      );
      self._state[c] = v;
      // }
    } catch (e) {
      console.error(e);
    }
  }
}

FRAME_RATE = 1 / 25.0;

var MAC = process.argv[2];

let config;
let configQueueCount = 0;
let groups = [];

/* RGB to Hex */

function RGBToHex(rgb) {
  let [r, g, b] = rgb;
  r = r.toString(16);
  g = g.toString(16);
  b = b.toString(16);

  if (r.length == 1) r = "0" + r;
  if (g.length == 1) g = "0" + g;
  if (b.length == 1) b = "0" + b;

  return "#" + r + g + b;
}

/* Create RGB from a css style hex string such as #123456 */

function hexToRGB(h) {
  let r = 0,
    g = 0,
    b = 0;
  h[0] = parseFloat(h[0]);
  h[1] = parseFloat(h[1]);
  h[2] = parseFloat(h[2]);
  // 3 digits
  if (h.length == 4) {
    r = "0x" + h[1] + h[1];
    g = "0x" + h[2] + h[2];
    b = "0x" + h[3] + h[3];

    // 6 digits
  } else if (h.length == 7) {
    r = "0x" + h[1] + h[2];
    g = "0x" + h[3] + h[4];
    b = "0x" + h[5] + h[6];
  }
  //console.log(parseInt(r),parseInt(g),parseInt(b))

  return [parseInt(r), parseInt(g), parseInt(b)];
}

function HSLToHex(hsl) {
  return RGBToHex(hsl2rgb(hsl));
}

function HexToHSL(hex) {
  return rgb2hsl(hexToRGB(hex));
}

/* Create HSL values from RGB */

function rgb2hsl(rgb) {
  let [r, g, b] = rgb;

  // Make r, g, and b fractions of 1
  r /= 255;
  g /= 255;
  b /= 255;

  // Find greatest and smallest channel values
  let cmin = Math.min(r, g, b),
    cmax = Math.max(r, g, b),
    delta = cmax - cmin,
    h = 0,
    s = 0,
    l = 0;
  // Calculate hue
  // No difference
  if (delta == 0) h = 0;
  // Red is max
  else if (cmax == r) h = ((g - b) / delta) % 6;
  // Green is max
  else if (cmax == g) h = (b - r) / delta + 2;
  // Blue is max
  else h = (r - g) / delta + 4;

  h = Math.round(h * 60);

  // Make negative hues positive behind 360°
  if (h < 0) h += 360;

  // Calculate lightness
  l = (cmax + cmin) / 2;

  // Calculate saturation
  s = delta == 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  // Multiply l and s by 100
  s = +(s * 100).toFixed(1);
  l = +(l * 100).toFixed(1);

  return [h, s, l];
}

function hsl2rgb(hsl) {
  h = hsl[0];
  s = hsl[1];
  l = hsl[2];
  // Must be fractions of 1
  s /= 100;
  l /= 100;

  let c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = l - c / 2,
    r = 0,
    g = 0,
    b = 0;

  if (0 <= h && h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (60 <= h && h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (120 <= h && h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (180 <= h && h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (240 <= h && h < 300) {
    r = x;
    g = 0;
    b = c;
  } else if (300 <= h && h < 360) {
    r = c;
    g = 0;
    b = x;
  }
  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);

  return [r, g, b];
}

/*

Problem

  Define one or more points in a circular buffer.
  Create a gradient between each point and both of its neighbours

*/

function interpolate(a, b, s) {
  // Generalized smoothstep
  function generalSmoothStep(N, x) {
    x = clamp(x, 0, 1); // x must be equal to or between 0 and 1
    var result = 0;
    for (var n = 0; n <= N; ++n) {
      result +=
        pascalTriangle(-N - 1, n) *
        pascalTriangle(2 * N + 1, N - n) *
        Math.pow(x, N + n + 1);
    }
    return result;
  }

  // Returns binomial coefficient without explicit use of factorials,
  // which can't be used with negative integers
  function pascalTriangle(a, b) {
    var result = 1;
    for (var i = 0; i < b; ++i) result *= (a - i) / (i + 1);
    return result;
  }

  function clamp(x, lowerlimit, upperlimit) {
    if (x < lowerlimit) x = lowerlimit;
    if (x > upperlimit) x = upperlimit;
    return x;
  }

  let r = [];
  if (s > 1) {
    for (var i = 0; i < s; i++) {
      let v = a + (b - a) * generalSmoothStep(1, (1.0 * i) / (s - 1));
      r.push(v);
    }
  } else {
    r = [b];
  }
  return r;
}

function interpolateRGB(x, y, steps) {
  let r = interpolate(x[0], y[0], steps);
  let g = interpolate(x[1], y[1], steps);
  let b = interpolate(x[2], y[2], steps);
  let result = [];
  for (var i = 0; i < steps; i++) {
    result.push([r[i], g[i], b[i]]);
  }
  return result;
}

function interpolateHSL(x, y, steps) {
  let h = [];
  let a = x[0];
  let b = y[0];
  let d = b - a;
  d = ((d + 180) % 360) - 180;

  if (d < 0) {
    interpolate((a - d) % 360, (b - d) % 360, steps).forEach(function (v, i) {
      h.push(v + d < 0 ? v + d + 360 : v + d);
    });
  } else {
    interpolate(a, b, steps).forEach(function (v, i) {
      h.push(v);
    });
  }
  let s = interpolate(x[1], y[1], steps);
  let l = interpolate(x[2], y[2], steps);
  let result = [];
  h.forEach(function (v, i) {
    result.push(hsl2rgb([h[i], s[i], l[i]]));
  });
  return result;
}

class ColourRing {
  constructor(size, mix) {
    this.size = size;
    this.mix = mix.toUpperCase();
    this.buffer = [];
    for (var i = 0; i < size; i++) {
      this.buffer[i] = [0, 0, 0];
    }
    this.points = {};
  }

  // Use a HSL value to specify a point
  addPoint(percent, value) {
    let self = this;
    let data = this.mix == "RGB" ? hsl2rgb(value) : value;
    let i = Math.round((this.size * percent) / 100.0);
    if (i >= this.size) {
      i = this.size - 1;
    }
    // console.log("Add Point", percent + "(" + i + ")", value, data);
    if (Object.keys(this.points).length == 0) {
      this.points[i] = { p: i, n: i, v: data };
    } else {
      let p = null;
      let n = null;
      let f = null;
      let l = null;
      Object.keys(this.points).forEach(function (x) {
        // Sorted keys
        let key = parseInt(x);
        if (n === null && key > i) {
          n = key;
        }
        if (key < i) {
          p = key;
        }
        if (f === null) {
          f = key;
        }
        l = key;
      });
      if (n === null) {
        n = f;
      }
      if (p === null) {
        p = l;
      }
      this.points[i] = { p: p, n: n, v: data };
      this.points[p].n = i;
      this.points[n].p = i;
    }
    this.buffer[i] = data;

    // console.log("Points", this.points);

    // Join with gradient

    let p = this.points[i].p;
    let n = this.points[i].n;

    let s = i - p;
    if (s < 0) {
      s += this.size;
    }
    if (s == 0) {
      s = this.size;
    }
    let g = this.gradient(this.points[p].v, this.points[i].v, s);
    for (var x = 0; x < g.length; x++) {
      this.buffer[(p + x + 1) % this.size] = g[x];
    }
    s = n - i;
    if (s < 0) {
      s += this.size;
    }
    g = this.gradient(this.points[i].v, this.points[n].v, s);
    for (var x = 0; x < g.length; x++) {
      this.buffer[(i + x + 1) % this.size] = g[x];
    }
  }

  gradient(v1, v2, steps) {
    // console.log("Gradient", v1, v2, steps, this.mix);
    let result = null;
    if (this.mix == "RGB") {
      result = interpolateRGB(v1, v2, steps);
    } else {
      result = interpolateHSL(v1, v2, steps);
    }
    return result;
  }
}

/* config
"lightingGroups": [
      {
        "name": "OPPSK COB light",
        "looped": true,
        "rgbChannels": [
          4,
          5,
          6,
          7
        ],
        "cortinaColour": [
          239,
          100,
          50
        ],
        "otherchannels": {
          "normal": "1-0   4-255   3-1   2-39  ",
          "cortina": "1-0   4-255   3-255   2-0   "
        },
        "enabled": true,
        "variations": [
          {
            "stepColourHSL": {
              "34": [
                120,
                100,
                50
              ],
              "78": [
                241,
                100,
                50
              ]
            },
            "cycleDuration": 5,
            "mix": "rgb",
            "label": "Version 1",
            "enabled": true
          },
          {
            "stepColourHSL": {
              "18": [
                0,
                100,
                50
              ]
            },
            "cycleDuration": 30,
            "mix": "hsl",
            "label": "Version 0",
            "enabled": false
          }
        ]
      },
  */

class Group {
  constructor(config, cortina, master) {
    this._config = config;
    this._cortina = cortina;
    this._master = master;
    this._step = null;
    this._sequence = null;

    // console.log("New group", config);

    // Identify the active variation

    this.activeVariation = config.variations.find((v) => {
      return v.enabled;
    });

    // Create the gradient data

    FRAME_RATE = 1 / this._master.frameRate;
    dmx.frameRate(this._master.frameRate);
    // console.log("Frame rate", FRAME_RATE);
    this._sequence = new ColourRing(
      Math.round(this.activeVariation.cycleDuration * this._master.frameRate),
      this.activeVariation.mix
    );
    for (let p of Object.keys(this.activeVariation.stepColourHSL)) {
      let hsl = this.activeVariation.stepColourHSL[p];
      hsl[2] = this._master.tanda_brightness * hsl[2];
      this._sequence.addPoint(Math.round(parseInt(p)), hsl);
    }
    this._sequence = this._sequence.buffer;

    this._fadingUp = false;
    this._fadingDown = false;
    this._fadeIdx = 0;
    this._fadeSequence = [];
    this._highestChannel = Math.max(
      this._config.rgbChannels[1],
      this._config.rgbChannels[2],
      this._config.rgbChannels[3]
    );
    this._additionalUp = [];
    let self = this;
    for (let c of this._config.otherchannels.cortina.split(" ")) {
      if (c) {
        let v = c.split(/[\:\-\_\.]/g);
        // console.log("split", c, v);
        self._additionalUp.push([Math.round(v[0]), Math.round(v[1])]);
        if (Math.round(v[0]) > self._highestChannel) {
          self._highestChannel = Math.round(v[0]);
        }
      }
    }
    this._additionalDown = [];
    for (let c of this._config.otherchannels.normal.split(" ")) {
      if (c) {
        let v = c.split(/[\:\-\_\.]/g);
        self._additionalDown.push([Math.round(v[0]), Math.round(v[1])]);
        if (Math.round(v[0]) > self._highestChannel) {
          self._highestChannel = Math.round(v[0]);
        }
      }
    }
    this._step = 0;
    // console.log(this);
  }

  evalNext(dmx) {
    try {
      if (configQueueCount === 0) {
        let values = [];
        for (let i = 0; i < this._highestChannel; i++) {
          values[i] = 0;
        }
        if (this._fadingUp || this._fadingDown) {
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[1] - 1,
            Math.round(this._fadeSequence[this._fadeIdx][0])
          );
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[2] - 1,
            Math.round(this._fadeSequence[this._fadeIdx][1])
          );
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[3] - 1,
            Math.round(this._fadeSequence[this._fadeIdx][2])
          );

          if (this._fadingDown) {
            for (let x of this._additionalDown) {
              dmx.setChannel(this._config.rgbChannels[0] + x[0] - 1, x[1]);
            }
          }

          if (this._fadingUp) {
            for (let x of this._additionalUp) {
              dmx.setChannel(this._config.rgbChannels[0] + x[0] - 1, x[1]);
            }
          }

          this._fadeIdx++;
          // console.log(
          //   "Fade progress:",
          //   this._fadingUp,
          //   this._fadeIdx,
          //   this._fadeSequence.length - 1
          // );
          if (this._fadeIdx > this._fadeSequence.length - 1) {
            if (this._fadingUp) {
              this._fadeIdx--; // hold
              // console.log("Holding", this._fadingUp);
            }
            this._fadingDown = false;
          }
        } else {
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[1] - 1,
            Math.round(this._sequence[this._step][0])
          );
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[2] - 1,
            Math.round(this._sequence[this._step][1])
          );
          dmx.setChannel(
            this._config.rgbChannels[0] + this._config.rgbChannels[3] - 1,
            Math.round(this._sequence[this._step][2])
          );
          for (let x of this._additionalDown) {
            dmx.setChannel(this._config.rgbChannels[0] + x[0] - 1, x[1]);
          }
          this._step++;
          if (this._step >= this._sequence.length) {
            this._step = 0;
          }
        }
      }
    } catch (e) {
      console.error(e);
      console.log(this);
      process.exit(1);
    }
  }

  fadeUp() {
    try {
      let dim = this._cortina.in.dipColour;
      dim[2] = dim[2] * this._master.cortina_brightness;
      this._fadeSequence = [];
      if (this._cortina.in.timeToDip > 0) {
        let t = new ColourRing(
          parseInt(this._cortina.in.timeToDip * this._master.frameRate),
          this.activeVariation.mix
        );
        t.addPoint(0, rgb2hsl(this._sequence[this._step]));
        t.addPoint(100, dim);
        for (let x of t.buffer) {
          this._fadeSequence.push(x);
        }
      } else {
        dim = rgb2hsl(this._sequence[this._step]);
      }

      if (this._cortina.in.dipTime > 0) {
        let t = new ColourRing(
          parseInt(this._cortina.in.dipTime * this._master.frameRate),
          this.activeVariation.mix
        );
        t.addPoint(0, dim);
        t.addPoint(100, dim);
        for (let x of t.buffer) {
          this._fadeSequence.push(x);
        }
      }

      if (this._cortina.in.finalFadeTime > 0) {
        let t = new ColourRing(
          parseInt(this._cortina.in.finalFadeTime * this._master.frameRate),
          this.activeVariation.mix
        );
        t.addPoint(0, dim);
        let hsl = this._config.cortinaColour;
        hsl[2] = hsl[2] * this._master.cortina_brightness;
        t.addPoint(100, hsl);
        for (let x of t.buffer) {
          this._fadeSequence.push(x);
        }
      }
      // this._fadeSequence.push(this._config.cortinaColour);

      this._fadingDown = false;
      this._fadingUp = true;
      this._fadeIdx = 0;
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }
  fadeDown() {
    try {
      // cortina: {
      //   in: {
      //     timeToDip: 0.6,
      //     dipTime: 0.3,
      //     dipColour: [Array],
      //     finalFadeTime: 3
      //   },
      //   out: { fadeTime: 5, tandaStartFadeDelay: 0 }
      // },
      if (this._cortina.out.fadeTime > 0) {
        let t = new ColourRing(
          parseInt(this._cortina.out.fadeTime * this._master.frameRate),
          this.activeVariation.mix
        );
        let hsl = this._config.cortinaColour;
        hsl[2] = hsl[2] * this._master.cortina_brightness;
        t.addPoint(0, hsl);
        t.addPoint(100, rgb2hsl(this._sequence[this._step]));
        this._fadeSequence = [];
        let idx = 0;
        for (let x of t.buffer) {
          this._fadeSequence[idx++] = x;
        }
        this._fadeSequence[idx] = this._sequence[this._step];

        this._fadingDown = true;
        this._fadingUp = false;
        this._fadeIdx = 0;
      }
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }

  setBrightness(v) {
    this._master.brightness = v;
  }
}

function on_config(data) {
  configQueueCount++;
  console.log("on_config");
  if (JSON.stringify(data) != JSON.stringify(config)) {
    console.log("config changed");
    console.log(data);
  }
  config = data;
  groups = [];
  for (let groupConfig of config.lightingGroups) {
    if (
      groupConfig.enabled &&
      groupConfig.variations.find((v) => {
        return v.enabled;
      })
    ) {
      groups.push(new Group(groupConfig, config.cortina, config.master));
    }
  }
  configQueueCount--;
}

function on_up_response() {
  console.log("on_up_response");
  if (configQueueCount == 0) {
    groups.forEach((group) => {
      group.fadeUp();
    });
  }
}

function on_down_response() {
  console.log("on_down_response");
  if (configQueueCount == 0) {
    groups.forEach((group) => {
      group.fadeDown();
    });
  }
}

function on_connect() {
  console.log("Connected");
}
function on_disconnect() {
  console.log("on_disconnect");
}

function on_reconnect() {
  console.log("on_reconnect");
}

socketIO.on("connect", on_connect);
socketIO.on("lightingConfig", on_config);
socketIO.on("lightsUp", on_up_response);
socketIO.on("lightsDown", on_down_response);
socketIO.on("disconnect", on_disconnect);
socketIO.on("reconnect", on_reconnect);
socketIO.on("master_lighting", (x) => {
  groups.forEach((group) => {
    group.setBrightness(x.brightness);
  });
});

// Tanda Player that this running

console.log(process.argv);
socketIO.emit("usingLighting", MAC);

dmx  = new DMX(1 / FRAME_RATE, null, (dmx) => {
  // let v = [0,39,1,255,255,0,0]
  // v.forEach((v,idx)=>{
  //   dmx.setChannel(40 + idx, v);

  // })
  if (configQueueCount == 0) {
    groups.forEach((group) => {
      group.evalNext(dmx);
    });
  }
});
