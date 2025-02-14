import time
import random
import serial
import serial.tools.list_ports
import socketio
from threading import Thread
from ola.ClientWrapper import ClientWrapper

SERVER_URL = 'http://tandaplayerbt.local:80'

class DMXDriver:
    def __init__(self, universe):
        self.universe = universe
        self.mode = 'normal'
        self.lights = {}
        self.buffer = [255] * 20
        self.rate = 1.0 / 44  # DMX rate
        self.run_thread = Thread(target=self.run)
        self.run_thread.daemon = True
        self.run_thread.start()

    def set_colour(self, addr, r, g, b, w):
        self.buffer[addr] = r
        self.buffer[addr + 1] = g
        self.buffer[addr + 2] = b
        self.buffer[addr + 3] = w

    def run(self):
        while True:
            for address, light in self.lights.items():
                r, g, b, w = light.transition(self.mode)
                self.set_colour(address, r, g, b, w)
            if self.universe:
                self.universe.SendDmx(1, bytes(self.buffer))
            time.sleep(self.rate)

    def add_light(self, address, light):
        print(f'Creating light on address {address}')
        self.lights[address] = light

    def sync(self, angle, duration, brightness):
        self.mode = 'sync'
        for light in self.lights.values():
            light.set_target(angle, duration, brightness)

    def unsync(self, duration):
        self.mode = 'normal'
        for light in self.lights.values():
            light.set_target(0, -duration, 0.5)


def find_serial_device(vendor_id=None):
    ports = serial.tools.list_ports.comports()
    for port in ports:
        if vendor_id and port.vid == int(vendor_id, 16):
            print(f'Found device on port: {port.device}')
            return port.device
    print('Device not found.')
    return None


def start_listening(port_name, baud_rate=115200):
    ser = serial.Serial(port_name, baud_rate, timeout=1)
    Thread(target=read_serial, args=(ser,), daemon=True).start()
    return ser


def read_serial(ser):
    while True:
        line = ser.readline().decode().strip()
        if line:
            process_esp_message(line)


def process_esp_message(message):
    print(f'Message: {message}')
    if not lights_up and message.startswith('UDP: '):
        values = message.split(',')
        color = float(values[0].split(':')[1])
        duration = float(values[1])
        brightness = float(values[2])
        sync_mode = values[3].strip().lower() == 'true'

        if sync_mode:
            dmx_driver.sync(color, duration, brightness)
        else:
            dmx_driver.unsync(0)
    else:
        print(f'Regular Serial Output: {message}')


def main():
    global dmx_driver, lights_up
    lights_up = False

    dmx_port = find_serial_device('0403')  # Example Vendor ID for FTDI
    esp_port = find_serial_device('1a86')  # Vendor ID for ESP8266

    wrapper = ClientWrapper()
    universe = wrapper.Client()
    dmx_driver = DMXDriver(universe)
    
    serial_port = None
    if esp_port:
        serial_port = start_listening(esp_port)
    
    sio = socketio.Client()
    
    @sio.on('connect')
    def on_connect():
        print('Connected to WebSocket server')

    @sio.on('lightsUp')
    def on_lights_up(data):
        global lights_up
        lights_up = True
        print(f'Received lightsUp: {data}')
        dmx_driver.sync(0, 3000, 1)
        if serial_port:
            serial_port.write(b'1\n')

    @sio.on('lightsDown')
    def on_lights_down(data):
        global lights_up
        lights_up = False
        print(f'Received lightsDown: {data}')
        dmx_driver.unsync(-3000)
        if serial_port:
            serial_port.write(b'0\n')
    
    sio.connect(SERVER_URL)
    sio.wait()


if __name__ == '__main__':
    main()
