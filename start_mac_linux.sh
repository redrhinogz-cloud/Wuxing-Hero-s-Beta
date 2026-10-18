#!/usr/bin/env sh
cd "$(dirname "$0")"
export WUXING_DATA_DIR="${WUXING_DATA_DIR:-$(pwd)/server-data}"
exec node server.js
