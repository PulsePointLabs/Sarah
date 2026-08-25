import io
import os
import unittest

from encrypted_transport import decrypt_chunks, decrypt_chunks_to_file, encrypt_stream


class EncryptedTransportTests(unittest.TestCase):
    def test_chunked_round_trip_and_integrity(self):
        source = os.urandom(12_345)
        stored = {}
        key = os.urandom(32)

        manifest = encrypt_stream(
            io.BytesIO(source),
            job_id="test-job",
            asset_id="test-asset",
            key=key,
            chunk_bytes=4096,
            upload_chunk=lambda name, payload: stored.__setitem__(name, payload.read()),
        )
        plaintext, digest = decrypt_chunks(
            manifest["chunks"],
            job_id="test-job",
            asset_id="test-asset",
            key=key,
            read_chunk=stored.__getitem__,
        )

        self.assertEqual(plaintext, source)
        self.assertEqual(digest, manifest["plaintext_sha256"])
        self.assertEqual(manifest["chunk_count"], 4)
        self.assertTrue(all(item["ciphertext_bytes"] == item["plaintext_bytes"] + 16 for item in manifest["chunks"]))

        destination = io.BytesIO()
        byte_count, file_digest = decrypt_chunks_to_file(
            manifest["chunks"],
            job_id="test-job",
            asset_id="test-asset",
            key=key,
            read_chunk=stored.__getitem__,
            destination=destination,
        )
        self.assertEqual(destination.getvalue(), source)
        self.assertEqual(byte_count, len(source))
        self.assertEqual(file_digest, manifest["plaintext_sha256"])

    def test_wrong_key_is_rejected(self):
        stored = {}
        manifest = encrypt_stream(
            io.BytesIO(b"private evidence"),
            job_id="test-job",
            asset_id="test-asset",
            key=os.urandom(32),
            upload_chunk=lambda name, payload: stored.__setitem__(name, payload.read()),
        )
        with self.assertRaises(Exception):
            decrypt_chunks(
                manifest["chunks"],
                job_id="test-job",
                asset_id="test-asset",
                key=os.urandom(32),
                read_chunk=stored.__getitem__,
            )


if __name__ == "__main__":
    unittest.main()
