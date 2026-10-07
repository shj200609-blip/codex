"""Drive the real interactive CLI in a controlling terminal for shared-server acceptance."""
import base64
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))


def terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                           preexec_fn=terminal, env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
print(json.dumps({'pid': process.pid}), flush=True)
try:
    while process.poll() is None:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            # crossterm queries cursor and terminal capabilities during startup.
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            print(json.dumps({'output': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            command = json.loads(line)
            if 'input' in command:
                os.write(master, command['input'].encode())
            if command.get('stop'):
                break
finally:
    if process.poll() is None:
        process.terminate()
    try:
        code = process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        code = process.wait()
    os.close(master)
    print(json.dumps({'exit': code}), flush=True)
