# Ack-paced bitmap sender (the logic of Launchkey.showBitmap in app/src/midi/launchkey.ts).
# One frame in flight at a time; the latest frame per target wins. The temporary target (0x21, the shift map)
# goes before the stationary one. A frame identical to the one last sent to a target is skipped unless forced.
from .. import protocol as P

ACK_TIMEOUT = 0.5  # s without an ack before the next frame goes anyway


class BitmapSender(object):
    def __init__(self, send, now):
        self._send = send
        self._now = now
        self.reset()

    def reset(self):
        """Forget everything sent (after a handshake the device shows nothing of ours)."""
        self._pending = {}
        self._last = {}
        self._in_flight_since = None
        self.acks = 0
        self.sent = 0

    def show(self, target, packed, force=False):
        if not force and target not in self._pending and self._last.get(target) == packed:
            return
        self._pending[target] = packed
        self.pump()

    def forget(self, target):
        """The next frame for `target` goes even when it equals the last one (the device dropped it)."""
        self._last.pop(target, None)
        self._pending.pop(target, None)

    def on_ack(self):
        self.acks += 1
        self._in_flight_since = None
        self.pump()

    def pump(self):
        if not self._pending:
            return
        if self._in_flight_since is not None and self._now() - self._in_flight_since < ACK_TIMEOUT:
            return
        target = P.DISPLAY_TEMPORARY if P.DISPLAY_TEMPORARY in self._pending else P.DISPLAY_STATIONARY
        packed = self._pending.pop(target)
        self._last[target] = packed
        self._in_flight_since = self._now()
        self.sent += 1
        self._send(P.bitmap_sysex(target, packed))
