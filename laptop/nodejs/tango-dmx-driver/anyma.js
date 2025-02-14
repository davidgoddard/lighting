
const usb = require('usb');

// These constants specify the Anyma uDMX device
const VENDOR_ID = 0x16c0;
const PRODUCT_ID = 0x5dc;

const UNIVERSE_LEN = 512;

class Anyma {
    constructor(deviceId = undefined, options = {}) {

        this.universe = Buffer.alloc(UNIVERSE_LEN);
        this.readyToWrite = true;
        this.interval = 1000 / (options.dmx_speed || 33);

        if (!deviceId) {
            this.device = usb.findByIds(VENDOR_ID, PRODUCT_ID);
        } else {
            const devices = usb
                .getDeviceList()
                .filter((d) => d.deviceDescriptor.idVendor === VENDOR_ID && d.deviceDescriptor.idProduct === PRODUCT_ID);
            if (deviceId.hasOwnProperty('busNumber') && deviceId.hasOwnProperty('deviceAddress')) {
                this.device = devices.find((d) => d.busNumber == deviceId.busNumber && d.deviceAddress == deviceId.deviceAddress);
            } else {
                this.device = devices[deviceId];
            }
        }
        if (!this.device) {
            throw new Error(`Couldn't find Anyma uDMX dongle for deviceId=${JSON.stringify(deviceId)}`);
        }
        this.device.open();


        //   this.start();
        console.log('Started OK')
    }

    start() {
        this.timeout = setInterval(() => {
            this.sendUniverse();
        }, this.interval);
    };

    stop() {
        clearInterval(this.timeout);
    };

    close(cb) {
        this.device.close();
        cb(null);
    };

    update(u, extraData) {
        for (const c in u) {
            this.universe[c - 1] = u[c];
        }
    };

    updateAll(v, _) {
        for (let i = 0; i < UNIVERSE_LEN; i++) {
            this.universe[i] = v;
        }
    };

    get(c) {
        return this.universe[c - 1];
    };

    async sendUniverse() {
        if (!this.readyToWrite) {
            return;
        }
        this.readyToWrite = false;
        await new Promise((resolve, reject) => {

            this.device.controlTransfer(0x40, 0x0002, UNIVERSE_LEN, 0, this.universe, (error) => {
                this.readyToWrite = true;
                if (error) {
                    console.error(error);
                    reject(error);
                } else {
                    resolve();
                }
            });
        })
    };
}

module.exports = Anyma;