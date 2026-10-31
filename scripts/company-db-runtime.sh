#!/bin/sh
# Bound native RocksDB caches on the shared 16GB Mac. The threshold is admission control, not an OS RSS cap.
set -eu
: "${SURREAL_MEMORY_THRESHOLD:=2147483648}"
: "${SURREAL_ROCKSDB_BLOCK_CACHE_SIZE:=536870912}"
: "${SURREAL_ROCKSDB_WRITE_BUFFER_SIZE:=33554432}"
: "${SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER:=4}"
for value in "$SURREAL_MEMORY_THRESHOLD" "$SURREAL_ROCKSDB_BLOCK_CACHE_SIZE" "$SURREAL_ROCKSDB_WRITE_BUFFER_SIZE" "$SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER"; do
  case "$value" in ''|*[!0-9]*) echo 'company database memory settings must be positive integer byte counts' >&2; exit 2;; esac
  [ "$value" -gt 0 ] || { echo 'company database memory settings must be positive' >&2; exit 2; }
done
export SURREAL_MEMORY_THRESHOLD SURREAL_ROCKSDB_BLOCK_CACHE_SIZE SURREAL_ROCKSDB_WRITE_BUFFER_SIZE SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER
echo "company db memory budgets: tracked=$SURREAL_MEMORY_THRESHOLD cache=$SURREAL_ROCKSDB_BLOCK_CACHE_SIZE write_buffer=$SURREAL_ROCKSDB_WRITE_BUFFER_SIZE buffers=$SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER"
exec "${1:?company fork binary required}" start --bind "${2:?loopback bind required}" --log warn "rocksdb:${3:?database directory required}"
