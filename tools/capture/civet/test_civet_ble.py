"""Protocol unit tests; no Bluetooth device is contacted."""
import unittest
from civet_ble import decode, ZERO_COMMAND
class ProtocolTests(unittest.TestCase):
    def test_official_pressure_examples(self):
        for encoded, value in [(bytes.fromhex('1603'), 7.9), (bytes.fromhex('a806'), 17.04), (bytes.fromhex('9cff'), -1.0)]:
            packet=bytearray(17);packet[0]=0xd0;packet[8:10]=encoded
            original=bytes(packet)
            self.assertEqual(decode(packet),value)
            self.assertEqual(bytes(packet),original)
    def test_unknown_and_truncated_packets(self):
        self.assertIsNone(decode(bytes(17)))
        self.assertIsNone(decode(bytes.fromhex('d001')))
    def test_zero_is_exact_manufacturer_example(self):
        self.assertEqual(ZERO_COMMAND.hex(),'66000000000000000000000002')
        self.assertEqual(len(ZERO_COMMAND),13)
if __name__=='__main__': unittest.main()
