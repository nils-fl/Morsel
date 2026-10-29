# The waveform for the Chop screen. Live doesn't hand a script a sample's audio, but Simpler names its file, and WAV and
# AIFF read with Python's own modules. A file is read once into BUCKETS peaks; a view zoomed in closer than those is
# read from the file again (a few thousand frames). Other formats (and float WAVs, which `wave` can't open): no wave.
import sys
import warnings
from array import array

try:
    import wave
except ImportError:
    wave = None
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)  # both go in Python 3.13; Live's is 3.11
    try:
        import aifc
    except ImportError:
        aifc = None
    try:
        import audioop  # min / max in C; Live's Python may not have it
    except ImportError:
        audioop = None

BUCKETS = 4096
STRIDE_SAMPLES = 512  # without audioop: at most this many samples looked at per chunk


def _open(path):
    low = path.lower()
    if low.endswith(".wav") and wave is not None:
        return wave.open(path, "rb"), sys.byteorder == "big"
    if low.endswith((".aif", ".aiff")) and aifc is not None:
        return aifc.open(path, "rb"), sys.byteorder == "little"  # AIFF is big-endian
    return None, False


def _minmax(data, width, swap):
    """(min, max) of PCM `data`, -1..1."""
    full = float(1 << (8 * width - 1))
    if audioop is not None:
        if swap:
            data = audioop.byteswap(data, width)
        if width == 1:
            data = audioop.bias(data, 1, -128)  # 8-bit WAV is unsigned
        lo, hi = audioop.minmax(data, width)
        return lo / full, hi / full
    n = len(data) // width
    step = max(1, n // STRIDE_SAMPLES)
    if width in (2, 4):
        a = array("h" if width == 2 else "i", data[:n * width])
        if swap:
            a.byteswap()
        vals = a[::step]
    elif width == 1:
        vals = [b - 128 for b in data[::step]]
    else:  # 24 bit
        order = "big" if swap != (sys.byteorder == "big") else "little"
        vals = [int.from_bytes(data[i * 3:i * 3 + 3], order, signed=True) for i in range(0, n, step)]
    if not len(vals):
        return 0.0, 0.0
    return min(vals) / full, max(vals) / full


class Peaks(object):
    """(min, max) per bucket, -1..1, over the whole file; `frames` long. `ok` is False when it couldn't be read."""

    def __init__(self, path):
        self.path = path
        self.frames = 0
        self.buckets = []
        self._width, self._channels, self._swap, self._per = 2, 1, False, 1
        self._cache = None
        try:
            f, swap = _open(path)
        except Exception:
            f = None
        if f is None:
            return
        try:
            self._width, self._channels, self._swap = f.getsampwidth(), f.getnchannels(), swap
            self.frames = f.getnframes()
            self._per = max(1, -(-self.frames // BUCKETS))
            while True:
                data = f.readframes(self._per)
                if not data:
                    break
                self.buckets.append(_minmax(data, self._width, self._swap))
        except Exception:
            self.buckets = []
        finally:
            f.close()

    @property
    def ok(self):
        return bool(self.buckets)

    def view(self, a, b, columns):
        """(min, max) for each of `columns` screen columns across frames a..b."""
        a, b = max(0, int(a)), min(self.frames, int(b))
        key = (a, b, columns)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        span = max(1, b - a)
        if span < 2 * columns * self._per:
            out = self._direct(a, b, columns)  # zoomed in closer than the buckets: read the file again
        else:
            out = []
            for c in range(columns):
                i0 = (a + span * c // columns) // self._per
                i1 = max(i0 + 1, (a + span * (c + 1) // columns) // self._per)
                part = self.buckets[i0:i1] or [(0.0, 0.0)]
                out.append((min(p[0] for p in part), max(p[1] for p in part)))
        self._cache = (key, out)
        return out

    def _direct(self, a, b, columns):
        f, _ = _open(self.path)
        try:
            f.setpos(a)
            data = f.readframes(b - a)
        finally:
            f.close()
        fb = self._width * self._channels
        n = len(data) // fb
        out = []
        for c in range(columns):
            s0 = n * c // columns
            s1 = max(s0 + 1, n * (c + 1) // columns)
            chunk = data[s0 * fb:s1 * fb]
            out.append(_minmax(chunk, self._width, self._swap) if chunk else (0.0, 0.0))
        return out
