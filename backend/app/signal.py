from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import numpy as np
from collections import deque

try:
    import pyBigWig  # type: ignore
except Exception:  # pragma: no cover
    pyBigWig = None  # type: ignore


@dataclass(frozen=True)
class BinnedSignal:
    plus: np.ndarray
    minus: np.ndarray


def _as_path_or_url(source: str) -> str:
    # pyBigWig supports both local file paths and URLs.
    p = Path(source).expanduser()
    return str(p) if p.exists() else source


@lru_cache(maxsize=64)
def _open_bigwig(source: str):
    if pyBigWig is None:
        raise RuntimeError("pyBigWig is not installed")
    resolved = _as_path_or_url(source)
    if resolved == source:
        # If it looks like a local path but doesn't exist, fail fast with a clearer message.
        p = Path(source).expanduser()
        if "://" not in source and ("/" in source or source.startswith(".")) and not p.exists():
            raise FileNotFoundError(f"bigWig not found: {source}")
    try:
        return pyBigWig.open(resolved)
    except RuntimeError as e:
        raise RuntimeError(f"Failed to open bigWig '{source}': {e}") from e


def _bin_reduce(values: np.ndarray, bins: int, mode: str) -> np.ndarray:
    """
    Reduce 1D array into `bins` by mean or max, ignoring NaNs.
    """
    n = int(values.shape[0])
    if bins <= 0:
        raise ValueError("bins must be > 0")
    if n == 0:
        return np.zeros((bins,), dtype=np.float32)
    if bins >= n:
        out = values.astype(np.float32, copy=False)
        out = np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)
        if out.shape[0] < bins:
            out = np.pad(out, (0, bins - out.shape[0]))
        return out[:bins]

    edges = np.linspace(0, n, num=bins + 1, dtype=np.int64)
    out = np.zeros((bins,), dtype=np.float32)
    for i in range(bins):
        a = int(edges[i])
        b = int(edges[i + 1])
        if b <= a:
            b = min(n, a + 1)
        chunk = values[a:b]
        if chunk.size == 0:
            out[i] = 0.0
            continue
        if mode == "max":
            out[i] = float(np.nanmax(chunk))
        else:
            out[i] = float(np.nanmean(chunk))
        if not np.isfinite(out[i]):
            out[i] = 0.0
    return out


def _gaussian_smooth(x: np.ndarray, window: int) -> np.ndarray:
    """
    Symmetric Gaussian smoothing with a finite window.

    Compared to a boxcar moving average, a Gaussian kernel tends to preserve
    peak location/shape better and avoids the "blocky/clumped" look.
    """
    if window <= 1:
        return x
    window = int(window)
    # Prefer odd length for perfect symmetry around the center.
    if window % 2 == 0:
        window += 1
    # Map window to sigma so that ~99% mass is within the window.
    # With radius ~3*sigma, full width ~= 6*sigma.
    sigma = max(1e-6, float(window) / 6.0)
    half = window // 2
    xs = np.arange(-half, half + 1, dtype=np.float32)
    kernel = np.exp(-0.5 * (xs / sigma) ** 2).astype(np.float32)
    s = float(kernel.sum())
    if s <= 0 or not np.isfinite(s):
        return x
    kernel /= s
    x = x.astype(np.float32, copy=False)
    y = np.convolve(x, kernel, mode="same")
    return y.astype(np.float32, copy=False)


def _sliding_window_max(x: np.ndarray, window: int) -> np.ndarray:
    """
    1D sliding window maximum (centered) in O(n).

    Returns an array of same length as x where each position i contains
    max(x[j]) for j in [i-half, i+half], clipped to the valid range.
    """
    x = x.astype(np.float32, copy=False)
    n = int(x.shape[0])
    if n == 0:
        return x
    w = int(window)
    if w <= 1:
        return x.copy()
    if w % 2 == 0:
        w += 1
    half = w // 2

    # Trailing max for window [i-w+1, i].
    dq: deque[int] = deque()
    trailing = np.empty((n,), dtype=np.float32)
    for i in range(n):
        xi = float(x[i])
        while dq and float(x[dq[-1]]) <= xi:
            dq.pop()
        dq.append(i)
        left = i - w + 1
        while dq and dq[0] < left:
            dq.popleft()
        trailing[i] = float(x[dq[0]])

    # Centered output: shift trailing index by +half.
    out = np.empty((n,), dtype=np.float32)
    for i in range(n):
        j = i + half
        if j >= n:
            j = n - 1
        out[i] = trailing[j]
    return out


def _local_peak_preserve(x: np.ndarray, s: np.ndarray, window: int) -> np.ndarray:
    """
    Peak-preserving smoothing:
    - s is a smoothed version of x (same length)
    - locally re-scale s so local maxima match x's local maxima
    """
    w = int(window)
    if w <= 1:
        return s
    if w % 2 == 0:
        w += 1
    eps = np.float32(1e-8)
    mx = _sliding_window_max(x, w)
    ms = _sliding_window_max(s, w)
    gain = mx / (ms + eps)
    # Prevent extreme amplification on sparse/noisy tracks.
    gain = np.clip(gain, 0.0, 5.0).astype(np.float32, copy=False)
    return (s.astype(np.float32, copy=False) * gain).astype(np.float32, copy=False)

def transform_signal(x: np.ndarray, smooth: int, spiky: float) -> np.ndarray:
    """
    smooth: moving average window in bins (0/1 => no smoothing)
    spiky: unsharp mask strength (0 => no sharpening)
    """
    x = x.astype(np.float32, copy=False)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    if smooth <= 1 and spiky <= 0:
        return x
    # For "spiky" to have an effect, the baseline must be smoother than x.
    # If user sets smooth=0/1 but spiky>0, use a small default baseline window.
    baseline_window = smooth
    if spiky > 0 and baseline_window <= 1:
        baseline_window = 9
    # Use Gaussian smoothing as the baseline (less distortive than a boxcar mean).
    s = _gaussian_smooth(x, baseline_window if baseline_window > 1 else 1)
    if spiky > 0:
        # unsharp mask: enhance high-frequency components.
        # Clamp to zero — signal is non-negative (read counts/coverage) and
        # negative values would bleed into the opposite strand in the UI.
        sharpened = (x + (x - s) * float(spiky)).astype(np.float32, copy=False)
        return np.maximum(sharpened, 0.0)
    # Default: peak-preserving smoothing (keeps local maxima from collapsing).
    if baseline_window > 1:
        return _local_peak_preserve(x, s, baseline_window)
    return s


def fetch_binned_track(
    source: str,
    strand: str,
    ref: str,
    start: int,
    end: int,
    bins: int,
    *,
    reduce_mode: str = "mean",
    smooth: int = 0,
    spiky: float = 0.0,
) -> BinnedSignal:
    bw = _open_bigwig(source)
    try:
        values = bw.values(ref, int(start), int(end), numpy=True)
    except RuntimeError as e:
        # Common: ref not present in file.
        raise RuntimeError(f"Failed to read '{ref}:{start}-{end}' from '{source}': {e}") from e
    if values is None:
        values = np.zeros((end - start,), dtype=np.float32)
    binned = _bin_reduce(values, bins=bins, mode=reduce_mode)
    # Important: many pipelines store minus-strand signal as negative values.
    # Our smoothing (especially peak-preserving smoothing) assumes non-negative magnitudes.
    if strand == "-":
        binned = np.abs(binned)
    else:
        binned = np.maximum(binned, 0.0)
    binned = transform_signal(binned, smooth=smooth, spiky=spiky)
    if strand == "-":
        return BinnedSignal(plus=np.zeros_like(binned), minus=binned.astype(np.float32, copy=False))
    return BinnedSignal(plus=binned.astype(np.float32, copy=False), minus=np.zeros_like(binned))


def shared_symmetric_ymax(items: Iterable[BinnedSignal]) -> float:
    m = 0.0
    for it in items:
        if it.plus.size:
            m = max(m, float(np.nanmax(np.abs(it.plus))))
        if it.minus.size:
            m = max(m, float(np.nanmax(np.abs(it.minus))))
    if not np.isfinite(m) or m <= 0:
        return 1.0
    return float(m)

