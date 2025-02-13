const DEBUG = false;

function getRandomColourAndDuration() {
    return {
        angle: Math.trunc(Math.random() * 360), // Random hue (0-360)
        duration: Math.trunc(2000 + Math.random() * 10000), // 3 to 15 seconds in milliseconds
        brightness: 0.5 // always normal brightness
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

let lightNumber = 0;
module.exports = class Light {
    constructor() {
        this.lightNumber = ++lightNumber;
        this.currentAngle = 0;
        this.currentBrightness = 0.5; // Start at 50% brightness
        this.origin = { angle: 0, duration: 0, brightness: 0 }
        this.target = { angle: 0, duration: 0, brightness: 0 }
        this.startTime = Date.now();
        this.colorStepPerMs = 0;
        this.brightnessStepPerMs = 0;
    }

    transition(currentMode) {
        let elapsed = Date.now() - this.startTime;

        if (elapsed >= this.target.duration) {
            if (DEBUG) console.log(this.lightNumber, currentMode, `Finished transition: ${this.currentAngle}, ${this.target.angle}`)
            this.setTarget(0, 0, 0.5);
        } else {
            this.currentAngle = this.origin.angle + this.colorStepPerMs * elapsed;
            this.currentBrightness = this.origin.brightness + this.brightnessStepPerMs * elapsed;
            // Normalize the angle to stay within 0-360
            if (this.currentAngle >= 360) this.currentAngle -= 360;
            else if (this.currentAngle < 0) this.currentAngle += 360;
            // if (DEBUG) console.log(this.lightNumber, currentMode, 'Current', this.currentAngle.toFixed(2), ' ==> ', this.origin, this.target, 'elapsed', elapsed, 'adjustment', (this.colorStepPerMs * elapsed).toFixed(2))
        }

        // console.log(this.lightNumber, 'Current angle', elapsed, target.angle, currentAngle)
        // Convert HSL to RGB and set the colour in the buffer
        let [r, g, b] = hslToRgb(this.currentAngle, 1, this.currentBrightness);
        let w = Math.trunc(Math.max(0, ((this.currentBrightness - 0.5) * 2) * 255));
        if (DEBUG) console.log(this.lightNumber, 'HSL',this.currentBrightness.toFixed(1),'RGBW', r,g,b,w)
        return [r, g, b, w];
    }

    setTarget(angle, duration, brightness) {
        // Transition complete, start a new one from wherever we are in the current one
        // Note that it may not be at the current target if the master sends a new target randomly
        this.origin = { angle: this.currentAngle, duration: this.target.duration, brightness: this.currentBrightness };
        if ( duration <= 0) {
            this.target = getRandomColourAndDuration();
            if ( duration < 0 ) this.target.duration = -duration;
        } else {
            this.target = { angle, duration, brightness };
        }
        let degreesToMove = this.target.angle - this.currentAngle;
        if (degreesToMove > 180) {
            degreesToMove -= 360;  // Move counter-clockwise if the difference is greater than 180
        } else if (degreesToMove < -180) {
            degreesToMove += 360;  // Move clockwise if the difference is less than -180
        }
        this.colorStepPerMs = degreesToMove / this.target.duration;
        this.brightnessStepPerMs = (this.target.brightness - this.currentBrightness) / this.target.duration;
        if (DEBUG) console.log(this.lightNumber, 'Brightness',this.currentBrightness, '=>', brightness, this.target.brightness, this.brightnessStepPerMs)
        // if (DEBUG) console.log(this.lightNumber, 'Current angle', this.currentAngle.toFixed(2))
        // if (DEBUG) console.log(this.lightNumber, 'New target', this.target, 'from', this.origin, 'degrees to move', degreesToMove.toFixed(2), 'in steps of size', this.colorStepPerMs.toFixed(2));
        this.startTime = Date.now();
    }

}
