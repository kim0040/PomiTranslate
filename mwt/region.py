"""Anvil region codec used by the shipped translator.

Compression ids follow Java Edition: 1 gzip, 2 zlib, 3 none, 4 LZ4.
Id 4 is Minecraft 1.20.5+ ``LZ4BlockOutputStream`` framing: each block starts
with the ASCII magic ``LZ4Block``, not a bare LZ4 block.
The external-chunk flag is the high bit of the compression byte inside the
region file. ``c.<x>.<z>.mcc`` holds only the compressed bytes. Minecraft's
``RegionFile.writeToExternalFile`` seeks past the 5-byte header before writing
that file.
"""

from __future__ import annotations

import gzip
import hashlib
import math
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

SECTOR = 4096
HEADER_SECTORS = 2
# A real chunk is a few hundred KiB of NBT. These caps stop a corrupt or hostile world from
# exhausting memory; a chunk over them is left exactly as it is and reported.
MAX_CHUNK_BYTES = 64 * 1024 * 1024
MAX_EXTERNAL_CHUNK_FILE_BYTES = 128 * 1024 * 1024
EXTERNAL_FLAG = 0x80
SUPPORTED_COMPRESSION = {1, 2, 3, 4}
LZ4_MAGIC = b"LZ4Block"
LZ4_HEADER_LENGTH = 21
LZ4_METHOD_RAW = 0x10
LZ4_METHOD_LZ4 = 0x20
LZ4_LEVEL_BASE = 10
LZ4_BLOCK_SIZE = 1 << 16
LZ4_SEED = 0x9747B28C
_XXH_P1 = 0x9E3779B1
_XXH_P2 = 0x85EBCA77
_XXH_P3 = 0xC2B2AE3D
_XXH_P4 = 0x27D4EB2F
_XXH_P5 = 0x165667B1


class RegionError(ValueError):
    pass


class ChunkTooLarge(RegionError):
    pass


class RegionLayoutUnsafe(RegionError):
    """The sector table is inconsistent, so rewriting the file could move or destroy data."""


class UnsupportedCompression(RegionError):
    def __init__(self, compression_id: int) -> None:
        self.compression_id = compression_id
        super().__init__(f"Unsupported region compression id {compression_id}")


def _rotl32(value: int, bits: int) -> int:
    value &= 0xFFFFFFFF
    return ((value << bits) | (value >> (32 - bits))) & 0xFFFFFFFF


def _xxh32_round(acc: int, lane: int) -> int:
    acc = (acc + (lane * _XXH_P2)) & 0xFFFFFFFF
    return (_rotl32(acc, 13) * _XXH_P1) & 0xFFFFFFFF


def _xxh32(data: bytes, seed: int) -> int:
    """XXH32. The empty input at seed 0 is 0x02CC5D05."""
    length = len(data)
    offset = 0
    if length >= 16:
        acc1 = (seed + _XXH_P1 + _XXH_P2) & 0xFFFFFFFF
        acc2 = (seed + _XXH_P2) & 0xFFFFFFFF
        acc3 = seed & 0xFFFFFFFF
        acc4 = (seed - _XXH_P1) & 0xFFFFFFFF
        while offset + 16 <= length:
            acc1 = _xxh32_round(acc1, struct.unpack_from("<I", data, offset)[0])
            acc2 = _xxh32_round(acc2, struct.unpack_from("<I", data, offset + 4)[0])
            acc3 = _xxh32_round(acc3, struct.unpack_from("<I", data, offset + 8)[0])
            acc4 = _xxh32_round(acc4, struct.unpack_from("<I", data, offset + 12)[0])
            offset += 16
        digest = (
            _rotl32(acc1, 1) + _rotl32(acc2, 7) + _rotl32(acc3, 12) + _rotl32(acc4, 18)
        ) & 0xFFFFFFFF
    else:
        digest = (seed + _XXH_P5) & 0xFFFFFFFF
    digest = (digest + length) & 0xFFFFFFFF
    while offset + 4 <= length:
        lane = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        digest = (digest + (lane * _XXH_P3)) & 0xFFFFFFFF
        digest = (_rotl32(digest, 17) * _XXH_P4) & 0xFFFFFFFF
    while offset < length:
        digest = (digest + (data[offset] * _XXH_P5)) & 0xFFFFFFFF
        digest = (_rotl32(digest, 11) * _XXH_P1) & 0xFFFFFFFF
        offset += 1
    digest ^= digest >> 15
    digest = (digest * _XXH_P2) & 0xFFFFFFFF
    digest ^= digest >> 13
    digest = (digest * _XXH_P3) & 0xFFFFFFFF
    digest ^= digest >> 16
    return digest


def _lz4_java_checksum(data: bytes) -> int:
    # LZ4BlockOutputStream hashes through Checksum.getValue(), which masks
    # the top 4 bits (StreamingXXHash32.asChecksum).
    return _xxh32(data, LZ4_SEED) & 0x0FFFFFFF


def _lz4_compression_level(block_size: int = LZ4_BLOCK_SIZE) -> int:
    return max(0, (block_size - 1).bit_length() - LZ4_LEVEL_BASE)


def _lz4_header(token: int, compressed_len: int, original_len: int, checksum: int) -> bytes:
    return (
        LZ4_MAGIC
        + bytes([token])
        + compressed_len.to_bytes(4, "little")
        + original_len.to_bytes(4, "little")
        + checksum.to_bytes(4, "little")
    )


def compress_lz4_block_stream(raw: bytes) -> bytes:
    """Frame ``raw`` the way ``new LZ4BlockOutputStream(out)`` does (64 KiB blocks)."""
    import lz4.block

    level = _lz4_compression_level()
    parts: list[bytes] = []
    for start in range(0, len(raw), LZ4_BLOCK_SIZE):
        chunk = raw[start : start + LZ4_BLOCK_SIZE]
        compressed = lz4.block.compress(chunk, store_size=False)
        if len(compressed) >= len(chunk):
            method = LZ4_METHOD_RAW
            body = chunk
        else:
            method = LZ4_METHOD_LZ4
            body = compressed
        parts.append(
            _lz4_header(method | level, len(body), len(chunk), _lz4_java_checksum(chunk)) + body
        )
    parts.append(_lz4_header(LZ4_METHOD_RAW | level, 0, 0, 0))
    return b"".join(parts)


def decompress_lz4_block_stream(payload: bytes, limit: int = MAX_CHUNK_BYTES) -> bytes:
    if not payload.startswith(LZ4_MAGIC):
        raise RegionError("LZ4 chunk does not start with LZ4Block")
    import lz4.block

    output = bytearray()
    offset = 0
    while offset < len(payload):
        if offset + LZ4_HEADER_LENGTH > len(payload):
            raise RegionError("Truncated LZ4Block header")
        if payload[offset : offset + 8] != LZ4_MAGIC:
            raise RegionError("LZ4 chunk is missing the LZ4Block magic")
        token = payload[offset + 8]
        method = token & 0xF0
        level = token & 0x0F
        compressed_len = int.from_bytes(payload[offset + 9 : offset + 13], "little")
        original_len = int.from_bytes(payload[offset + 13 : offset + 17], "little")
        checksum = int.from_bytes(payload[offset + 17 : offset + 21], "little")
        offset += LZ4_HEADER_LENGTH
        if original_len == 0:
            if compressed_len != 0 or checksum != 0:
                raise RegionError("Invalid LZ4Block end marker")
            break
        if original_len > (1 << (LZ4_LEVEL_BASE + level)):
            raise RegionError("LZ4Block length exceeds the declared block size")
        if len(output) + original_len > limit:
            raise ChunkTooLarge("LZ4 chunk expands beyond the size limit")
        if offset + compressed_len > len(payload):
            raise RegionError("Truncated LZ4Block payload")
        body = payload[offset : offset + compressed_len]
        offset += compressed_len
        if method == LZ4_METHOD_RAW:
            if compressed_len != original_len:
                raise RegionError("Raw LZ4Block length mismatch")
            raw = body
        elif method == LZ4_METHOD_LZ4:
            raw = lz4.block.decompress(body, uncompressed_size=original_len)
        else:
            raise RegionError(f"Unknown LZ4Block method {method:#x}")
        if len(raw) != original_len:
            raise RegionError("LZ4Block decompressed length mismatch")
        if _lz4_java_checksum(raw) != checksum:
            raise RegionError("LZ4Block checksum mismatch")
        output.extend(raw)
    return bytes(output)


def compress_payload(compression: int, raw_nbt: bytes) -> bytes:
    if compression == 1:
        return gzip.compress(raw_nbt)
    if compression == 2:
        return zlib.compress(raw_nbt)
    if compression == 3:
        return raw_nbt
    if compression == 4:
        return compress_lz4_block_stream(raw_nbt)
    raise UnsupportedCompression(compression)


def _inflate_bounded(payload: bytes, wbits: int, limit: int, *, members: bool) -> bytes:
    """Stream-inflate, stopping as soon as the output would pass ``limit``."""
    output = bytearray()
    remaining = payload
    while True:
        inflater = zlib.decompressobj(wbits)
        output += inflater.decompress(remaining, limit + 1 - len(output))
        if len(output) > limit:
            raise ChunkTooLarge("Chunk expands beyond the size limit")
        if not inflater.eof:
            raise RegionError("Truncated compressed chunk")
        remaining = inflater.unused_data
        # gzip allows several members and zero padding; zlib is one stream.
        if not members or not remaining.strip(b"\x00"):
            return bytes(output)


def decompress_payload(compression: int, payload: bytes, limit: int | None = None) -> bytes:
    if limit is None:
        limit = MAX_CHUNK_BYTES  # read at call time
    if compression == 1:
        return _inflate_bounded(payload, 16 + zlib.MAX_WBITS, limit, members=True)
    if compression == 2:
        return _inflate_bounded(payload, zlib.MAX_WBITS, limit, members=False)
    if compression == 3:
        if len(payload) > limit:
            raise ChunkTooLarge("Chunk is larger than the size limit")
        return payload
    if compression == 4:
        return decompress_lz4_block_stream(payload, limit)
    raise UnsupportedCompression(compression)


def chunk_coords(index: int, region_x: int = 0, region_z: int = 0) -> tuple[int, int]:
    return region_x * 32 + (index % 32), region_z * 32 + (index // 32)


def region_coordinates(region_path: Path) -> tuple[int, int]:
    """Region x and z from a file name such as ``r.-1.3.mca``. Unknown names count as 0, 0."""
    parts = region_path.name.split(".")
    if len(parts) >= 4 and parts[0] == "r" and parts[-1] == "mca":
        try:
            return int(parts[1]), int(parts[2])
        except ValueError:
            pass
    return 0, 0


def count_populated_chunks(region_path: Path) -> int | None:
    """Chunks a region file declares in its header, without reading any of them. None if unreadable."""
    try:
        with region_path.open("rb") as stream:
            locations = stream.read(SECTOR)
    except OSError:
        return None
    if len(locations) < SECTOR:
        return None
    return sum(
        1 for index in range(1024)
        if int.from_bytes(locations[index * 4 : index * 4 + 3], "big") and locations[index * 4 + 3]
    )


def external_chunk_path(region_path: Path, index: int) -> Path:
    region_x, region_z = region_coordinates(region_path)
    x, z = chunk_coords(index, region_x, region_z)
    return region_path.parent / f"c.{x}.{z}.mcc"


@dataclass
class ChunkRecord:
    index: int
    empty: bool = True
    compression: int = 0
    external: bool = False
    payload: bytes = b""
    record_bytes: bytes = b""
    mcc_bytes: bytes | None = None
    raw_nbt: bytes | None = None
    malformed: bool = False
    unsupported: bool = False
    unsupported_id: int | None = None
    modified: bool = False
    timestamp: int = 0
    slot: tuple[int, int] | None = None  # (first sector, sector count) as the header declared it
    oversize: bool = False  # left untouched because it exceeds the decompression cap


@dataclass
class RegionFile:
    path: Path | None
    chunks: list[ChunkRecord] = field(default_factory=list)
    original_bytes: bytes = b""
    layout_unsafe: str = ""  # why the sector table cannot be trusted; empty when it can

    @classmethod
    def empty(cls) -> RegionFile:
        return cls(path=None, chunks=[ChunkRecord(index=i) for i in range(1024)])

    @classmethod
    def read(cls, path: Path) -> RegionFile:
        data = path.read_bytes()
        region = cls(path=path, original_bytes=data, chunks=[])
        if len(data) < SECTOR * HEADER_SECTORS:
            raise RegionError(f"Region header is too small: {path}")
        locations = data[:SECTOR]
        timestamps = data[SECTOR : SECTOR * 2]
        region.layout_unsafe = _layout_problem(locations, len(data))
        for index in range(1024):
            loc = locations[index * 4 : index * 4 + 4]
            offset = int.from_bytes(loc[:3], "big")
            count = loc[3]
            timestamp = int.from_bytes(timestamps[index * 4 : index * 4 + 4], "big")
            record = ChunkRecord(index=index, timestamp=timestamp)
            if offset == 0 or count == 0:
                region.chunks.append(record)
                continue
            start = offset * SECTOR
            end = start + count * SECTOR
            sector = data[start:end]
            record.empty = False
            record.slot = (offset, count)
            try:
                record.record_bytes, record.compression, record.external, record.payload = _split_record(sector)
            except RegionError:
                record.malformed = True
                record.record_bytes = sector.rstrip(b"\x00") or sector[:5]
                region.chunks.append(record)
                continue
            if record.external:
                mcc = external_chunk_path(path, index)
                if not mcc.is_file():
                    record.malformed = True
                elif mcc.stat().st_size > MAX_EXTERNAL_CHUNK_FILE_BYTES:
                    record.malformed = record.oversize = True
                else:
                    record.mcc_bytes = mcc.read_bytes()
                    if not record.mcc_bytes:
                        record.malformed = True
                    else:
                        record.payload = record.mcc_bytes
            base = record.compression
            if base not in SUPPORTED_COMPRESSION:
                record.unsupported = True
                record.unsupported_id = base
                region.chunks.append(record)
                continue
            if record.oversize:
                region.chunks.append(record)
                continue
            try:
                record.raw_nbt = decompress_payload(base, record.payload)
            except ChunkTooLarge:
                record.malformed = record.oversize = True
                record.raw_nbt = None
            except Exception:
                record.malformed = True
                record.raw_nbt = None
            region.chunks.append(record)
        return region

    @property
    def unsupported_ids(self) -> list[int]:
        return sorted({chunk.unsupported_id for chunk in self.chunks if chunk.unsupported_id is not None})

    def put_nbt(self, index: int, raw_nbt: bytes, compression: int = 2, timestamp: int = 0, external: bool = False) -> None:
        if compression not in SUPPORTED_COMPRESSION:
            raise UnsupportedCompression(compression)
        payload = compress_payload(compression, raw_nbt)
        chunk = self.chunks[index]
        chunk.empty = False
        chunk.compression = compression
        chunk.external = external
        chunk.payload = payload
        chunk.raw_nbt = raw_nbt
        chunk.modified = True
        chunk.malformed = False
        chunk.unsupported = False
        chunk.timestamp = timestamp
        chunk.record_bytes = _pack_record(compression, payload, external=False)
        if external:
            chunk.mcc_bytes = payload
            chunk.record_bytes = (1).to_bytes(4, "big") + bytes([compression | EXTERNAL_FLAG])

    def put_raw_record(self, index: int, record_bytes: bytes, timestamp: int = 0) -> None:
        chunk = self.chunks[index]
        chunk.empty = False
        chunk.modified = True
        chunk.timestamp = timestamp
        chunk.record_bytes = record_bytes
        try:
            _, compression, external, payload = _split_record(record_bytes + b"\x00" * 8)
        except RegionError:
            chunk.malformed = True
            return
        chunk.compression = compression
        chunk.external = external
        chunk.payload = payload
        if compression not in SUPPORTED_COMPRESSION:
            chunk.unsupported = True
            chunk.unsupported_id = compression

    def replace_nbt(self, index: int, raw_nbt: bytes) -> None:
        chunk = self.chunks[index]
        compression = chunk.compression if chunk.compression in SUPPORTED_COMPRESSION else 2
        external = chunk.external
        payload = compress_payload(compression, raw_nbt)
        # Oversized payloads cannot stay inside a 255-sector slot.
        if not external and len(payload) + 5 > 255 * SECTOR:
            external = True
        chunk.raw_nbt = raw_nbt
        chunk.payload = payload
        chunk.compression = compression
        chunk.external = external
        chunk.modified = True
        chunk.malformed = False
        if external:
            chunk.mcc_bytes = payload
            chunk.record_bytes = (1).to_bytes(4, "big") + bytes([compression | EXTERNAL_FLAG])
        else:
            chunk.mcc_bytes = None
            chunk.record_bytes = _pack_record(compression, payload, external=False)

    def build(self, *, allow_unsupported: bool = False) -> tuple[bytes, dict[int, bytes]]:
        if not allow_unsupported and any(chunk.unsupported for chunk in self.chunks):
            raise UnsupportedCompression(self.unsupported_ids[0] if self.unsupported_ids else -1)
        if self.layout_unsafe:
            raise RegionLayoutUnsafe(self.layout_unsafe)
        locations = bytearray(SECTOR)
        timestamps = bytearray(SECTOR)
        body = bytearray()
        cursor = HEADER_SECTORS
        mcc_files: dict[int, bytes] = {}
        for chunk in self.chunks:
            if chunk.empty:
                continue
            if not chunk.modified and chunk.slot is not None and self.original_bytes:
                # Never repack what was not edited: a malformed or odd slot keeps every sector.
                first, count = chunk.slot
                # The layout gate guarantees every sector of the slot exists; none is invented here.
                raw = self.original_bytes[first * SECTOR : (first + count) * SECTOR]
                locations[chunk.index * 4 : chunk.index * 4 + 3] = cursor.to_bytes(3, "big")
                locations[chunk.index * 4 + 3] = count
                timestamps[chunk.index * 4 : chunk.index * 4 + 4] = int(chunk.timestamp).to_bytes(4, "big")
                body.extend(raw)
                cursor += count
                continue
            record = chunk.record_bytes
            if not record:
                record = _pack_record(chunk.compression, chunk.payload, external=chunk.external)
            needed = max(1, math.ceil(len(record) / SECTOR))
            if needed > 255:
                raise RegionError("Chunk exceeds the internal sector limit and was not externalized")
            locations[chunk.index * 4 : chunk.index * 4 + 3] = cursor.to_bytes(3, "big")
            locations[chunk.index * 4 + 3] = needed
            timestamps[chunk.index * 4 : chunk.index * 4 + 4] = int(chunk.timestamp).to_bytes(4, "big")
            body.extend(record)
            pad = needed * SECTOR - len(record)
            if pad:
                body.extend(b"\x00" * pad)
            cursor += needed
            if chunk.external and chunk.mcc_bytes is not None and chunk.modified:
                mcc_files[chunk.index] = chunk.mcc_bytes
        return bytes(locations) + bytes(timestamps) + bytes(body), mcc_files

    def payload_fingerprint(self, index: int) -> str:
        chunk = self.chunks[index]
        material = chunk.record_bytes + (chunk.mcc_bytes or b"")
        return hashlib.sha256(material).hexdigest()


def _layout_problem(locations: bytes, file_size: int) -> str:
    """Empty string when every location is either empty or a complete, in-file, non-overlapping slot.

    A slot counts as in the file only if all its sectors are physically there: a final slot that
    stops short is damage, and rewriting the file around it would invent the missing bytes. An
    entry with only one of offset/count set is damage too, not an empty slot.
    """
    slots: list[tuple[int, int]] = []
    for index in range(1024):
        offset = int.from_bytes(locations[index * 4 : index * 4 + 3], "big")
        count = locations[index * 4 + 3]
        if offset == 0 and count == 0:
            continue
        if offset == 0 or count == 0:
            return f"chunk {index} has an incomplete location entry"
        if offset < HEADER_SECTORS:
            return f"chunk {index} slot overlaps the region header"
        if (offset + count) * SECTOR > file_size:
            return f"chunk {index} slot extends past the end of the file"
        slots.append((offset, count))
    slots.sort()
    for (first, count), (next_first, _) in zip(slots, slots[1:]):
        if first + count > next_first:
            return "chunk slots overlap"
    return ""


def _split_record(sector: bytes) -> tuple[bytes, int, bool, bytes]:
    if len(sector) < 5:
        raise RegionError("Chunk sector is too small")
    length = int.from_bytes(sector[:4], "big")
    if length <= 0 or 4 + length > len(sector):
        raise RegionError("Invalid chunk length")
    scheme = sector[4]
    external = bool(scheme & EXTERNAL_FLAG)
    compression = scheme & 0x7F
    payload = sector[5 : 4 + length]
    record = sector[: 4 + length]
    return record, compression, external, payload


def _pack_record(compression: int, payload: bytes, external: bool) -> bytes:
    if external:
        return (1).to_bytes(4, "big") + bytes([compression | EXTERNAL_FLAG])
    length = len(payload) + 1
    return length.to_bytes(4, "big") + bytes([compression]) + payload


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()
