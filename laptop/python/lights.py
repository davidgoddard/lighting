import time
import random

DEBUG = False

def get_random_colour_and_duration():
    return {
        "angle": random.randint(0, 360),
        "duration": random.randint(2000, 12000),  # 2 to 12 seconds
        "brightness": 0.5  # Always normal brightness
    }

def hsl_to_rgb(h, s, l):
    def hue2rgb(p, q, t):
        if t < 0:
            t += 1
        if t > 1:
            t -= 1
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 0.5:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    if s == 0:
        r = g = b = l  # Achromatic
    else:
        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        r = hue2rgb(p, q, h / 360 + 1 / 3)
        g = hue2rgb(p, q, h / 360)
        b = hue2rgb(p, q, h / 360 - 1 / 3)
    
    return [round(r * 255), round(g * 255), round(b * 255)]

class Light:
    light_counter = 0

    def __init__(self):
        Light.light_counter += 1
        self.light_number = Light.light_counter
        self.current_angle = 0
        self.current_brightness = 0.5
        self.origin = {"angle": 0, "duration": 0, "brightness": 0}
        self.target = {"angle": 0, "duration": 0, "brightness": 0}
        self.start_time = time.time()
        self.color_step_per_ms = 0
        self.brightness_step_per_ms = 0

    def transition(self, current_mode):
        elapsed = (time.time() - self.start_time) * 1000  # Convert to ms

        if elapsed >= self.target["duration"]:
            if DEBUG:
                print(self.light_number, current_mode, f"Finished transition: {self.current_angle}, {self.target['angle']}")
            self.set_target(0, 0, 0.5)
        else:
            self.current_angle = self.origin["angle"] + self.color_step_per_ms * elapsed
            self.current_brightness = self.origin["brightness"] + self.brightness_step_per_ms * elapsed
            self.current_angle %= 360  # Normalize angle within 0-360
        
        r, g, b = hsl_to_rgb(self.current_angle, 1, self.current_brightness)
        w = max(0, int(((self.current_brightness - 0.5) * 2) * 255))
        
        if DEBUG:
            print(self.light_number, "HSL", self.current_brightness, "RGBW", r, g, b, w)
        
        return [r, g, b, w]

    def set_target(self, angle, duration, brightness):
        self.origin = {"angle": self.current_angle, "duration": self.target["duration"], "brightness": self.current_brightness}
        if duration <= 0:
            self.target = get_random_colour_and_duration()
            if duration < 0:
                self.target["duration"] = -duration
        else:
            self.target = {"angle": angle, "duration": duration, "brightness": brightness}
        
        degrees_to_move = self.target["angle"] - self.current_angle
        if degrees_to_move > 180:
            degrees_to_move -= 360
        elif degrees_to_move < -180:
            degrees_to_move += 360
        
        self.color_step_per_ms = degrees_to_move / self.target["duration"]
        self.brightness_step_per_ms = (self.target["brightness"] - self.current_brightness) / self.target["duration"]
        
        if DEBUG:
            print(self.light_number, "Brightness", self.current_brightness, "=>", brightness, self.target["brightness"], self.brightness_step_per_ms)
        
        self.start_time = time.time()
