from __future__ import annotations

import argparse
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default="/tmp/compute-bot-heartbeat")
    parser.add_argument("--max-age", type=float, default=45)
    args = parser.parse_args()
    try:
        age = time.time() - Path(args.path).stat().st_mtime
    except OSError:
        return 1
    return 0 if age <= args.max_age else 1


if __name__ == "__main__":
    raise SystemExit(main())
