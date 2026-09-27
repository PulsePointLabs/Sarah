"""Local CIVET BLE acquisition. Pressure reporting and explicitly requested deflated-sensor zero only."""
import asyncio, json, sys, time, threading, queue
# Exact official example (13 bytes despite the prose saying 12). No padding guesses.
ZERO_COMMAND = bytes.fromhex("66000000000000000000000002")
commands = queue.Queue()
def read_commands():
    for line in sys.stdin:
        try:
            commands.put(json.loads(line))
        except (ValueError, TypeError):
            emit({"error": "Invalid CIVET helper command"})
from bleak import BleakClient, BleakScanner
UUID = lambda part: f'0000{part}-0000-1000-8000-00805f9b34fb'
def emit(data):
    print(json.dumps(data), flush=True)
def decode(packet):
    if not 10 <= len(packet) <= 20 or packet[0] != 0xD0:
        return None
    return int.from_bytes(packet[8:10], 'little', signed=True) / 100
async def main():
    if sys.argv[1] == 'scan':
        devices = await BleakScanner.discover(timeout=8, return_adv=True)
        emit({'devices': [{'address': d.address, 'name': a.local_name or d.name or 'CIVET'} for d,a in devices.values() if (a.local_name or d.name or '').startswith('47L124') or 'civet' in (a.local_name or d.name or '').lower()]})
        return
    address = sys.argv[2]
    threading.Thread(target=read_commands, daemon=True).start()
    connection_id = 0
    wall_anchor, mono_anchor = time.time_ns(), time.monotonic_ns()
    while True:
        try:
            emit({'state': 'connecting'})
            device = await BleakScanner.find_device_by_address(address, timeout=12)
            if not device:
                raise RuntimeError('CIVET not found. Power it on and enable discoverable mode.')
            async with BleakClient(device, timeout=20) as client:
                connection_id += 1
                last = time.monotonic()
                sequence = 0
                def pressure(_, data):
                    nonlocal last, sequence
                    value = decode(data)
                    if value is None:
                        emit({'error': 'Unexpected CIVET pressure packet; check firmware compatibility.'})
                        return
                    last = time.monotonic()
                    sequence += 1
                    received_ns = time.monotonic_ns()
                    emit({'pressure_kpa': value, 'timestamp_ms': (wall_anchor + received_ns - mono_anchor) // 1000000, 'monotonic_ms': received_ns // 1000000, 'sequence': sequence, 'connection_id': connection_id, 'raw_packet_hex': bytes(data).hex(), 'raw_pressure_integer': int.from_bytes(data[8:10], 'little', signed=True)})
                await client.start_notify(UUID('150b'), pressure)
                characteristic = client.services.get_characteristic(UUID('150a'))
                await client.write_gatt_char(characteristic, bytes([0x50, 1, 0xD0] + [0]*14), response='write' in characteristic.properties)
                emit({'state': 'connected'})
                try:
                    emit({'battery': int((await client.read_gatt_char(UUID('1500')))[0])})
                except Exception:
                    pass
                while client.is_connected:
                    await asyncio.sleep(.1)
                    while not commands.empty():
                        command = commands.get_nowait()
                        if command.get('action') != 'zero':
                            emit({'command_id': command.get('command_id'), 'success': False, 'error': 'Unsupported command'})
                            continue
                        try:
                            await client.write_gatt_char(characteristic, ZERO_COMMAND, response='write' in characteristic.properties)
                            emit({'command_id': command.get('command_id'), 'success': True, 'command_hex': ZERO_COMMAND.hex(), 'timestamp_ms': (wall_anchor + time.monotonic_ns() - mono_anchor) // 1000000})
                        except Exception as error:
                            emit({'command_id': command.get('command_id'), 'success': False, 'error': str(error)[:250]})
                    if time.monotonic() - last > 5:
                        raise RuntimeError('No pressure packets for five seconds; reconnecting.')
        except Exception as error:
            emit({'state': 'reconnecting', 'error': str(error)[:250]})
        while not commands.empty():
            command = commands.get_nowait()
            emit({'command_id': command.get('command_id'), 'success': False, 'error': 'Sensor disconnected; zero was not sent'})
        await asyncio.sleep(2)
if __name__ == '__main__':
    asyncio.run(main())
