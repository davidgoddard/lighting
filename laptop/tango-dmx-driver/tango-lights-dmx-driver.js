const DMX = require('dmx');
const dmx = new DMX();
const Light = require('./light.js');
const io = require("socket.io-client");
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline'); // Correct import for Readline parser

const SERVER_URL = 'http://192.168.68.62:80';

let buffer = new Array(512).fill(0);

let dmxDriver;

function setColour(addr, r, g, b) {
    buffer[addr] = r;
    buffer[addr + 1] = g;
    buffer[addr + 2] = b;
}

class Driver {

    constructor(universe) {
        this.mode = 'normal';
        this.lights = new Map();
        const rate = 1000 / 40
        const run = async () => {
            for (const [address, light] of this.lights) {
                // console.log('Run', address, light)
                const [r, g, b] = light.transition(this.mode);
                setColour(address, r, g, b);
            }
            // If no universe, assume debugging so still run just don't output!
            if (universe) universe.update(buffer);
            setTimeout(run, rate);
        }
        setTimeout(run, rate);
    }

    addLight(address, light) {
        this.lights.set(address, light);
    }

    sync(angle, duration, brightness) {
        this.mode = 'sync';
        for (const [address, light] of this.lights) {
            light.setTarget(angle, duration, brightness);
        }
    }

    unsync(duration) {
        this.mode = 'normal';
        for (const [address, light] of this.lights) {
            light.setTarget(0, -duration, 0.5);
        }
    }


}


// Function to find the DMX interface serial port
async function findDMXPort() {
    try {
        // List the available serial ports
        const ports = await SerialPort.list();

        // Loop through the available ports to find the DMX interface
        for (let port of ports) {
            // Check if the port has a manufacturer or product identifier that matches the DMX
            if (port.vendorId && port.vendorId == '1a86') {
                console.log(`Found DMX interface on port: ${port.path}`);
                startListening(port.path);  // Start the server on the found port
                return;
            }
        }

        console.log('DMX interface device not found.');
    } catch (err) {
        console.error('Error listing ports:', err);
    }
}


// Function to find the ESP8266 serial port
async function findESP8266Port() {
    try {
        // List the available serial ports
        const ports = await SerialPort.list();

        // Loop through the available ports to find the ESP8266
        for (let port of ports) {
            // Check if the port has a manufacturer or product identifier that matches the ESP8266
            if (port.vendorId && port.vendorId == '1a86') {
                console.log(`Found ESP8266 on port: ${port.path}`);
                return port.path;
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

    parser.on('data', processESPMessage);

    port.on('open', () => {
        console.log('Serial port opened!');
    });

    return port;
}

function processESPMessage(data) {
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
            dmxDriver.sync(colour, duration, brightness);
        } else {
            dmxDriver.unsync(0);
        }
    } else {
        console.log('Regular Serial Output:', message)
    }
};


function runEmulation(){
    // emulate periodic updates.
    let syncMode = true;
    let duration;
    let brightness = 0.5;
    let lightsUp = false;
    let lightsWereUp = false;
    const newTarget = () => {
        const color = Math.trunc(Math.random() * 360);
        if (lightsUp) {
            brightness = 1;
            lightsWereUp = true;
            duration = 3000
            processESPMessage(Buffer.from(`UDP: ${color},${duration},${brightness},true`))
        } else {
            duration = lightsWereUp ? 3000 : 5000;
            brightness = 0.5;
            processESPMessage(Buffer.from(`UDP: ${color},${duration},${brightness},${syncMode}`))
        }
        setTimeout(newTarget, duration);
    }
    newTarget();
    setInterval(() => {
        syncMode = !syncMode;
    }, 20000)

    function cortina() {
        lightsUp = !lightsUp;
        if (lightsUp) {
            setTimeout(cortina, 10000); // 10 seconds of cortina
        } else {
            setTimeout(cortina, 45000); // 45 seconds between cortinas.
        }
    }
    setTimeout(cortina, 45000);
}


const main = async () => {
    const dmxInterfacePort = await findDMXPort();
    let universe;
    if (dmxInterfacePort) {
        universe = dmx.addUniverse('my_dmx_universe', 'enttec-open-usb-dmx', dmxInterfacePort);
    }

    // Connect to WebSocket server
    const socket = io(SERVER_URL);

    socket.on("connect", () => {
        console.log("Connected to WebSocket server");
    });

    dmxDriver = new Driver(universe);
    const dmxChannelSpacingPerLight = 5;
    for (let address = 0; address < (dmxInterfacePort ? 4 : 2); address++) {
        dmxDriver.addLight(1 + (address * dmxChannelSpacingPerLight), new Light())
    }

    // Start by finding the ESP8266 port
    const espPort = await findESP8266Port();
    let serialPort;
    if (espPort) {
        serialPort = startListening(espPort);  // Start the server on the found port
    } else {
        // runEmulation();
    }

    // socket.onAny((event, data) => {
    //     console.log(`Received event: ${event}`, data);
    // });

    let timer;
    // Handle incoming WebSocket messages
    socket.on("lightsUp", (data) => {
        console.log("Received message:", data);

        const colour = 0;
        const duration = 3000;
        const brightness = 1;
        dmxDriver.sync(colour, duration, brightness);

        timer = setTimeout(()=>{
            const duration = 300000;
            dmxDriver.sync(colour, duration, brightness);
        },duration)

        // Send message to ESP8266 over serial
        if (serialPort?.isOpen) {
            const message = JSON.stringify(data) + "\n"; // Ensure newline termination
            port.write(message, (err) => {
                if (err) {
                    return console.error("Error writing to serial:", err.message);
                }
                console.log("Message sent to ESP8266:", message);
            });
        }
    });


    socket.on("lightsDown", (data) => {
        console.log("Received message:", data);

        dmxDriver.unsync(-3000);

        if ( timer ){
            clearTimeout(timer);
            timer = null;
        }

        // Send message to ESP8266 over serial
        if (serialPort?.isOpen) {
            const message = JSON.stringify(data) + "\n"; // Ensure newline termination
            port.write(message, (err) => {
                if (err) {
                    return console.error("Error writing to serial:", err.message);
                }
                console.log("Message sent to ESP8266:", message);
            });
        }
    });
}

main();