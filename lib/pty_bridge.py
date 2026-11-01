"""Pseudo-terminal bridge for gitera/debug.

Runs `bash -i` on a pty and copies bytes between it and stdin/stdout. File descriptor 3,
when open, is a control pipe: each line `<cols> <rows>` resizes the pty, and the kernel
sends SIGWINCH to the foreground job so full-screen tools redraw at the new size.
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

CONTROL_FD = 3
MAX_COLS = 500
MAX_ROWS = 200


def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        data = data[written:]


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def apply_control(master, line):
    parts = line.split()
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        return
    cols, rows = int(parts[0]), int(parts[1])
    if 0 < cols <= MAX_COLS and 0 < rows <= MAX_ROWS:
        set_size(master, cols, rows)


def main():
    pid, master = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "-i"])

    inputs = [0, master]
    try:
        os.fstat(CONTROL_FD)
        inputs.append(CONTROL_FD)
    except OSError:
        pass

    control = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue

        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:  # EIO once the shell has exited (Linux)
                data = b""
            if not data:
                break
            write_all(1, data)

        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                inputs.remove(0)

        if CONTROL_FD in ready:
            data = os.read(CONTROL_FD, 1024)
            if not data:
                inputs.remove(CONTROL_FD)
                continue
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                apply_control(master, line.decode("ascii", "ignore"))

    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)


if __name__ == "__main__":
    main()
