#!/usr/bin/env python3
"""Manual PTY smoke for the fullscreen TUI — NOT a CI suite.

Drives the real bundle through a pseudo-terminal with real keystrokes and
asserts on the app's actual ANSI output. Two modes:

  functional  — no transcript content needed: startup chrome and sidebar,
                Ctrl+F search bar open / type / close, highlight SGR,
                Alt+Up/Down no-crash, clean exit.
  content     — runs local `!seq` / `!echo` commands first (no provider
                needed) so the scrollbar, the SGR mouse click-to-seek and the
                search counter exercise real transcript depth.

Usage:
  node scripts/build-cli-bundle.mjs
  DUYA_DATA_ROOT=/tmp/duya-smoke node packages/cli/bundle/cli.cjs serve &
  python3 scripts/smoke-tui-pty.py functional packages/cli/bundle/cli.cjs /tmp/capture.log /tmp/duya-smoke
  python3 scripts/smoke-tui-pty.py content    packages/cli/bundle/cli.cjs /tmp/capture.log /tmp/duya-smoke

These are the harnesses that found the search-bar repaint bug and verified
the layout-tree swap (plan 2026-11-11-tui-fullscreen-framework). They need a
running Host, real timing and a PTY — run them by hand, never in CI.
"""

import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

MODE, BUNDLE, LOG, DATA_ROOT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

env = dict(os.environ)
env.update({
    'DUYA_TUI_INLINE': '0',
    'DUYA_DATA_ROOT': DATA_ROOT,
    'TERM': 'xterm-256color',
})

pid, fd = pty.fork()
if pid == 0:
    os.execvpe('node', ['node', BUNDLE, 'tui'], env)

# The TUI sizes itself from TIOCGWINSZ, not from LINES/COLUMNS env: a pty
# without a winsize is a 0x0 terminal, and the frame loop paints nothing.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))

out = bytearray()


def pump(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            out.extend(chunk)


def send(data, settle=0.9):
    os.write(fd, data)
    pump(settle)


def wait_stable(idle=1.5, limit=15.0):
    deadline = time.time() + limit
    while time.time() < deadline:
        before = len(out)
        pump(idle)
        if len(out) == before:
            return


wait_stable()

search_open = typed = closed = altup = altdown = searched = 0
content = scrolled = scrolled2 = click1 = 0
click_hits = 0

if MODE == 'functional':
    send(b'\x06', 1.0)             # Ctrl+F: open the search bar
    search_open = len(out)
    send(b'du', 0.7)               # type a query
    typed = len(out)
    send(b'\x1b', 0.7)             # Esc: close
    closed = len(out)
    send(b'\x1b[1;3A', 0.7)        # Alt+Up: turn jump (no anchors -> no-op)
    altup = len(out)
    send(b'\x1b[1;3B', 0.7)        # Alt+Down
    send(b'\x14', 0.7)             # Ctrl+T: expand-all (harmless repaint)
    send(b'\x03', 0.3)             # Ctrl+C (first press: interrupt / arm exit)
    send(b'\x03', 3.0)             # Ctrl+C again: exit
    pump(2.0)
else:
    # Text and Enter go as SEPARATE writes: one burst ending in \r trips the
    # paste-burst heuristic, and a pasted newline becomes content, not submit.
    send(b'!seq 1 200', 0.5)
    send(b'\r', 6.0)
    send(b'!echo marker-two', 0.5)
    send(b'\r', 6.0)
    send(b'!seq 100 300', 0.5)
    send(b'\r', 6.0)
    send(b'!echo marker-three', 0.5)
    send(b'\r', 6.0)
    content = len(out)
    send(b'\x14', 1.2)             # Ctrl+T: expand every block (collapsed cards hide the depth)
    send(b'\x1b[5~', 0.9)          # PgUp: app-owned scroll away from the tail
    scrolled = len(out)
    send(b'\x1b[5~', 0.5)
    scrolled2 = len(out)
    # SGR mouse on the scrollbar track: probe candidate columns — the one that
    # lands produces a seek repaint, a miss writes nothing.
    for col in (108, 109, 110, 111):
        before = len(out)
        send(('\x1b[<0;%d;12M' % col).encode(), 0.8)
        send(('\x1b[<0;%d;12m' % col).encode(), 0.8)
        if len(out) > before + 40:
            click_hits += 1
    click1 = len(out)
    send(b'\x1b[1;3A', 0.9)        # Alt+Up: previous prompt
    altup = len(out)
    send(b'\x1b[1;3B', 0.9)        # Alt+Down: next prompt
    altdown = len(out)
    send(b'\x06', 0.9)             # Ctrl+F: search over real content
    send(b'marker', 0.9)
    searched = len(out)
    send(b'\x1b', 0.5)
    send(b'\x03', 0.3)
    send(b'\x03', 3.0)
    pump(2.0)

text = out.decode('utf-8', errors='replace')
plain = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', text)
with open(LOG, 'w', encoding='utf-8') as handle:
    handle.write(text)

if MODE == 'functional':
    checks = {
        'started (fullscreen chrome + sidebar drawn)': 'Sess' in plain and len(out) > 4000,
        'Ctrl+F opened search bar (hint rendered)': 'Enter next' in plain,
        'query text rendered in search bar': '/ du' in plain,
        'match highlight painted (searchMatchBg SGR)': b'48;5;58' in bytes(out) or b'48;5;100' in bytes(out),
        'search bar gone after Esc': 'Enter next' not in plain[closed:],
        'Alt+Up/Down no crash (frames after)': len(out) > altup,
        'clean exit (alt screen left)': b'?1049l' in out[-4000:],
    }
else:
    checks = {
        'local command card rendered (seq output)': 'seq' in plain or 'marker-two' in plain,
        'scrollbar thumb painted after scroll-away': '█' in text[content:scrolled2],
        'paused marker shown while scrolled': '[paused]' in text[content:],
        'scrollbar click seek changed the frame': click_hits >= 1,
        'Ctrl+F search over content: bar + counter': 'Enter next' in text[altdown:searched],
        'clean exit (alt screen left)': b'?1049l' in out[-4000:],
    }

for name, ok in checks.items():
    print(('PASS' if ok else 'FAIL'), name)
failed = [name for name, ok in checks.items() if not ok]
print('RESULT:', 'ALL PASS' if not failed else 'FAILED %d' % len(failed))
try:
    os.close(fd)
except OSError:
    pass
