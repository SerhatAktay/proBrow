from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .models import TrackSpec


@dataclass(frozen=True)
class AppConfig:
    tracks: list[TrackSpec]
    genes_path: str | None
    default_ref: str
    default_start: int
    default_end: int


def _default_color(i: int, strand: str) -> str:
    plus = ["#7dd3fc", "#a7f3d0", "#c4b5fd", "#fde68a"]
    minus = ["#fb7185", "#fda4af", "#f59e0b", "#f472b6"]
    palette = plus if strand != "-" else minus
    return palette[i % len(palette)]


def load_config_from_args(tracks: list[tuple[str, str, str]], genes: str | None) -> AppConfig:
    specs: list[TrackSpec] = []
    for idx, (name, source, strand) in enumerate(tracks):
        track_id = f"{name}_{'plus' if strand != '-' else 'minus'}_{idx}"
        specs.append(
            TrackSpec(
                id=track_id,
                name=name,
                source=str(source),
                strand=strand,
                color=_default_color(idx, strand),
            )
        )

    genes_path = str(Path(genes).expanduser()) if genes else None
    return AppConfig(
        tracks=specs,
        genes_path=genes_path,
        default_ref="chr1",
        default_start=0,
        default_end=50_000,
    )

