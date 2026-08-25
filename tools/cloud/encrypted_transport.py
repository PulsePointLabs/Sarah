"""Chunked authenticated encryption for Sarah cloud-analysis media transport."""

from __future__ import annotations

import base64
import hashlib
import io
import os
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import BinaryIO

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _aad(job_id: str, asset_id: str, chunk_index: int) -> bytes:
    return f"{job_id}:{asset_id}:{chunk_index}".encode("utf-8")


def encrypt_stream(
    source: BinaryIO,
    *,
    job_id: str,
    asset_id: str,
    key: bytes,
    upload_chunk: Callable[[str, io.BytesIO], None],
    chunk_bytes: int = DEFAULT_CHUNK_BYTES,
) -> dict:
    """Encrypt and upload a file incrementally without writing a local copy."""
    if len(key) != 32:
        raise ValueError("Sarah cloud job keys must be exactly 32 bytes.")
    if chunk_bytes < 1024:
        raise ValueError("chunk_bytes must be at least 1024 bytes.")

    cipher = AESGCM(key)
    chunks = []
    source_hash = hashlib.sha256()
    total_plaintext = 0
    index = 0

    while True:
        plaintext = source.read(chunk_bytes)
        if not plaintext:
            break
        nonce = os.urandom(12)
        aad = _aad(job_id, asset_id, index)
        ciphertext = cipher.encrypt(nonce, plaintext, aad)
        remote_path = f"jobs/{job_id}/{asset_id}/chunk-{index:06d}.aesgcm"
        upload_chunk(remote_path, io.BytesIO(ciphertext))
        chunk_hash = hashlib.sha256(plaintext).hexdigest()
        source_hash.update(plaintext)
        chunks.append({
            "index": index,
            "remote_path": remote_path,
            "nonce_b64": _b64(nonce),
            "plaintext_bytes": len(plaintext),
            "ciphertext_bytes": len(ciphertext),
            "plaintext_sha256": chunk_hash,
        })
        total_plaintext += len(plaintext)
        index += 1

    return {
        "asset_id": asset_id,
        "chunk_bytes": chunk_bytes,
        "chunk_count": len(chunks),
        "plaintext_bytes": total_plaintext,
        "plaintext_sha256": source_hash.hexdigest(),
        "chunks": chunks,
    }


def encrypt_file(
    local_path: str | Path,
    **kwargs,
) -> dict:
    with Path(local_path).open("rb") as source:
        return encrypt_stream(source, **kwargs)


def decrypt_chunks(
    chunks: Iterable[dict],
    *,
    job_id: str,
    asset_id: str,
    key: bytes,
    read_chunk: Callable[[str], bytes],
) -> tuple[bytes, str]:
    """Decrypt chunks and verify each plaintext digest. Used by tests/workers."""
    cipher = AESGCM(key)
    output = bytearray()
    source_hash = hashlib.sha256()
    for expected_index, item in enumerate(chunks):
        index = int(item["index"])
        if index != expected_index:
            raise ValueError(f"Non-contiguous encrypted chunk sequence at {index}.")
        nonce = base64.b64decode(item["nonce_b64"], validate=True)
        ciphertext = read_chunk(str(item["remote_path"]))
        plaintext = cipher.decrypt(nonce, ciphertext, _aad(job_id, asset_id, index))
        digest = hashlib.sha256(plaintext).hexdigest()
        if digest != item["plaintext_sha256"]:
            raise ValueError(f"Plaintext digest mismatch for chunk {index}.")
        output.extend(plaintext)
        source_hash.update(plaintext)
    return bytes(output), source_hash.hexdigest()


def decrypt_chunks_to_file(
    chunks: Iterable[dict],
    *,
    job_id: str,
    asset_id: str,
    key: bytes,
    read_chunk: Callable[[str], bytes],
    destination: BinaryIO,
) -> tuple[int, str]:
    """Decrypt verified chunks into an ephemeral worker file without buffering the asset."""
    cipher = AESGCM(key)
    source_hash = hashlib.sha256()
    total_bytes = 0
    for expected_index, item in enumerate(chunks):
        index = int(item["index"])
        if index != expected_index:
            raise ValueError(f"Non-contiguous encrypted chunk sequence at {index}.")
        nonce = base64.b64decode(item["nonce_b64"], validate=True)
        ciphertext = read_chunk(str(item["remote_path"]))
        plaintext = cipher.decrypt(nonce, ciphertext, _aad(job_id, asset_id, index))
        digest = hashlib.sha256(plaintext).hexdigest()
        if digest != item["plaintext_sha256"]:
            raise ValueError(f"Plaintext digest mismatch for chunk {index}.")
        destination.write(plaintext)
        source_hash.update(plaintext)
        total_bytes += len(plaintext)
    return total_bytes, source_hash.hexdigest()
