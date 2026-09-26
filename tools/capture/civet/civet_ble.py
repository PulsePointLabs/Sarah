"""Local CIVET BLE acquisition. Only pressure reporting commands are written."""
import asyncio, json, sys, time
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
    wall_anchor, mono_anchor = time.time_ns(), time.monotonic_ns()
    while True:
        try:
            emit({'state': 'connecting'})
            device = await BleakScanner.find_device_by_address(address, timeout=12)
            if not device:
                raise RuntimeError('CIVET not found. Power it on and enable discoverable mode.')
            async with BleakClient(device, timeout=20) as client:
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
                    emit({'pressure_kpa': value, 'timestamp_ms': (wall_anchor + time.monotonic_ns() - mono_anchor) // 1000000, 'monotonic_ms': time.monotonic_ns() // 1000000, 'sequence': sequence})
                await client.start_notify(UUID('150b'), pressure)
                characteristic = client.services.get_characteristic(UUID('150a'))
                await client.write_gatt_char(characteristic, bytes([0x50, 1, 0xD0] + [0]*14), response='write' in characteristic.properties)
                emit({'state': 'connected'})
                try:
                    emit({'battery': int((await client.read_gatt_char(UUID('1500')))[0])})
                except Exception:
                    pass
                while client.is_connected:
                    await asyncio.sleep(1)
                    if time.monotonic() - last > 5:
                        raise RuntimeError('No pressure packets for five seconds; reconnecting.')
        except Exception as error:
            emit({'state': 'reconnecting', 'error': str(error)[:250]})
        await asyncio.sleep(2)
if __name__ == '__main__':
    asyncio.run(main())
