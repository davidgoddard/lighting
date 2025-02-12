const DMX = require('dmx');
const dmx = new DMX();

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline'); // Correct import for Readline parser

let buffer = new Array(512).fill(0);

function setColour(addr, r, g, b) {
    buffer[addr] = r;
    buffer[addr + 1] = g;
    buffer[addr + 2] = b;
}


class Light {
    constructor() {
        this.currentAngle = 0;
        this.currentBrightness = 50; // Start at 50% brightness
        this.target = { angle: 0, duration: 0, brightness: 0 }
        this.startTime = Date.now();
        this.colorStepPerMs = 0;
        this.mode = 'normal';
    }

    transition() {
        let elapsed = Date.now() - this.startTime;
        this.startTime = Date.now();

        if (Math.abs(this.currentAngle - this.target.angle) <= 1) {
            // Transition complete, start a new one
            this.currentAngle = this.target.angle;
            this.currentBrightness = this.target.brightness;
            this.target = getRandomColourAndDuration();
            console.log('New target', this.target);
            let degreesToMove = this.target.angle - this.currentAngle;
            if (degreesToMove > 180) {
                degreesToMove -= 360;  // Move counter-clockwise if the difference is greater than 180
            } else if (degreesToMove < -180) {
                degreesToMove += 360;  // Move clockwise if the difference is less than -180
            }
            this.colorStepPerMs = degreesToMove / this.target.duration;
        } else {
            this.currentAngle += this.colorStepPerMs * elapsed;
            // Normalize the angle to stay within 0-360
            if (this.currentAngle >= 360) this.currentAngle -= 360;
            else if (this.currentAngle < 0) this.currentAngle += 360;
        }

        // console.log('Current angle', elapsed, target.angle, currentAngle)
        // Convert HSL to RGB and set the colour in the buffer
        let [r, g, b] = hslToRgb(this.currentAngle, 1, 0.50);
        return [r, g, b];
    }

    setTarget(angle, duration, brightness) {
        this.mode = 'sync';
        this.currentAngle = this.target.angle;
        this.currentBrightness = this.target.brightness;
        this.target = { angle, duration, brightness };
        console.log('New target from ESP-NOW', this.target);
        let degreesToMove = this.target.angle - this.currentAngle;
        if (degreesToMove > 180) {
            degreesToMove -= 360;  // Move counter-clockwise if the difference is greater than 180
        } else if (degreesToMove < -180) {
            degreesToMove += 360;  // Move clockwise if the difference is less than -180
        }
        this.colorStepPerMs = degreesToMove / this.target.duration;
        this.startTime = Date.now();
        console.log(`Light mode ${this.mode}`)
    }

    unsync() {
        this.mode = 'normal';
        console.log(`Light mode ${this.mode}`)
    }

}


class Driver {

    constructor(universe) {
        this.mode = 'normal';
        this.lights = new Map();
        const rate = 1000 / 40
        const run = async () => {
            for (const [address, light] of this.lights) {
                // console.log('Run', address, light)
                const [r, g, b] = light.transition();
                setColour(address, r, g, b);
            }
            universe.update(buffer);
            setTimeout(run, rate);
        }
        setTimeout(run, rate);
    }

    addLight(address, light) {
        this.lights.set(address, light);
    }

    sync(angle, duration, brightness) {
        for (const [address, light] of this.lights) {
            light.setTarget(angle, duration, brightness);
        }
    }

    unsync() {
        for (const [address, light] of this.lights) {
            light.unsync();
        }
    }


}




const universe = dmx.addUniverse('my_dmx_universe', 'enttec-open-usb-dmx', '/dev/tty.usbserial-BG00QGXZ');

const d = new Driver(universe);
d.addLight(1, new Light())
d.addLight(5, new Light())


// Function to find the ESP8266 serial port
async function findESP8266Port() {
    try {
        // List the available serial ports
        const ports = await SerialPort.list();

        // Loop through the available ports to find the ESP8266
        for (let port of ports) {
            console.log(`Checking port: ${port.path}`, port);

            // Check if the port has a manufacturer or product identifier that matches the ESP8266
            if (port.vendorId && port.vendorId == '1a86') {
                console.log(`Found ESP8266 on port: ${port.path}`);
                startListening(port.path);  // Start the server on the found port
                return;
            }
        }

        console.log('ESP8266 device not found.');
    } catch (err) {
        console.error('Error listing ports:', err);
    }
}

// Function to start listening on the found port
function startListening(portName) {
    const port = new SerialPort({
        path: portName,
        baudRate: 115200, // Match this with your ESP8266's baud rate
    });

    // Use the ReadlineParser to handle incoming data
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    parser.on('data', (data) => {
        const message = data.toString().trim();
        console.log('Message', message)
        if (message.startsWith('UDP: ')) {
            const values = message.split(/[,:]/g);
            console.log(values)

            const colour = parseFloat(values[1]);
            const duration = parseFloat(values[2]);
            const brightness = parseFloat(values[3]);
            const syncMode = values[4] === 'true';

            console.log('UDP message', colour, duration, brightness, syncMode)

            if (syncMode) {
                d.sync(colour, duration, brightness);
            } else {
                d.unsync();
            }
        } else {
            console.log('Regular Serial Output:', message)
        }
    });

    port.on('open', () => {
        console.log('Serial port opened!');
    });
}

// Start by finding the ESP8266 port
findESP8266Port();

function getRandomColourAndDuration() {
    return {
        angle: Math.trunc(Math.random() * 360), // Random hue (0-360)
        duration: Math.trunc(1000 + Math.random() * 25000), // 5 to 30 seconds in milliseconds
        brightness: Math.random() * 100 // L value in HSL (0-100%)
    };
}

function hslToRgb(h, s, l) {
    let r, g, b;

    if (s === 0) {
        r = g = b = l; // Achromatic (grey)
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 0.5) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };

        let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        let p = 2 * l - q;
        r = hue2rgb(p, q, h / 360 + 1 / 3);
        g = hue2rgb(p, q, h / 360);
        b = hue2rgb(p, q, h / 360 - 1 / 3);
    }

    // Convert to integers and return as an array [R, G, B]
    return [
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255)
    ];
}



