#!/usr/bin/env python3
"""Download one Old Faithful epoch (CAR + slot-ranges index) to a local mirror directory.

Parallel ranged GETs written in place with pwrite; progress is kept in a `.done` sidecar so an
interrupted download resumes where it stopped. The finished layout matches the archive
(`<root>/<epoch>/epoch-<epoch>.car`) so Jetstreamer can read it through serve_mirror.py.

Usage: fetch_epoch.py <epoch> [root] [--streams N]
"""
import argparse
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://files.old-faithful.net"
CHUNK = 64 << 20  # 64 MiB per ranged request
UA = {"User-Agent": "lm-archive-mirror/1.0"}


def head_len(url):
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def fetch_small(url, path):
    if os.path.exists(path):
        return
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("epoch", type=int)
    ap.add_argument("root", nargs="?", default="/data/oldfaithful")
    ap.add_argument("--streams", type=int, default=16)
    a = ap.parse_args()

    d = os.path.join(a.root, str(a.epoch))
    os.makedirs(d, exist_ok=True)
    name = f"epoch-{a.epoch}.car"
    car, part, donef = os.path.join(d, name), os.path.join(d, name + ".part"), os.path.join(d, name + ".done")
    url = f"{BASE}/{a.epoch}/{name}"

    fetch_small(f"{BASE}/{a.epoch}/epoch-{a.epoch}-slot-ranges.raw",
                os.path.join(d, f"epoch-{a.epoch}-slot-ranges.raw"))
    if os.path.exists(car):
        print(f"{car} already complete")
        return

    size = head_len(url)
    n = (size + CHUNK - 1) // CHUNK
    done = set()
    if os.path.exists(donef):
        with open(donef) as f:
            done = {int(x) for x in f.read().split()}
    todo = [i for i in range(n) if i not in done]

    fd = os.open(part, os.O_RDWR | os.O_CREAT, 0o644)
    os.ftruncate(fd, size)
    lock = threading.Lock()
    dlog = open(donef, "a")
    got = [0]
    t0 = time.time()

    def work(i):
        start = i * CHUNK
        end = min(size, start + CHUNK) - 1
        want = end - start + 1
        for attempt in range(30):
            try:
                req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    if r.status != 206:
                        raise IOError(f"HTTP {r.status}")
                    off = start
                    while True:
                        buf = r.read(4 << 20)
                        if not buf:
                            break
                        os.pwrite(fd, buf, off)
                        off += len(buf)
                if off - start != want:
                    raise IOError(f"short read {off - start}/{want}")
                with lock:
                    dlog.write(f"{i}\n")
                    dlog.flush()
                    got[0] += want
                return
            except Exception as e:  # noqa: BLE001 - retry anything transient
                time.sleep(min(60, 2 ** min(attempt, 6)))
                last = e
        raise RuntimeError(f"chunk {i} failed: {last}")

    def report():
        while not stop.is_set():
            stop.wait(60)
            el = time.time() - t0
            have = (len(done) * CHUNK) + got[0]
            print(f"{time.strftime('%H:%M:%S')} epoch {a.epoch}: {min(have, size) / 1e9:.1f}/{size / 1e9:.1f} GB "
                  f"{got[0] * 8 / el / 1e6:.0f} Mbps", flush=True)

    stop = threading.Event()
    threading.Thread(target=report, daemon=True).start()
    with ThreadPoolExecutor(a.streams) as ex:
        for f in [ex.submit(work, i) for i in todo]:
            f.result()
    stop.set()
    os.fsync(fd)
    os.close(fd)
    dlog.close()
    if os.path.getsize(part) != size:
        sys.exit("size mismatch")
    os.replace(part, car)
    os.remove(donef)
    print(f"{car} complete: {size / 1e9:.1f} GB in {(time.time() - t0) / 60:.0f} min", flush=True)


if __name__ == "__main__":
    main()
