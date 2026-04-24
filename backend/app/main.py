from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import numpy as np

from .config import AppConfig
from .genes import GeneIndex, parse_coordinate_query
from .signal import fetch_binned_track, shared_symmetric_ymax


def create_app(cfg: AppConfig) -> FastAPI:
    app = FastAPI(title="proBrow", version="0.1.0")
    gene_index = GeneIndex.from_path(cfg.genes_path)

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def root() -> FileResponse:
        return FileResponse(str(static_dir / "index.html"))

    @app.get("/api/config")
    def api_config() -> dict[str, Any]:
        return {
            "tracks": [t.model_dump() for t in cfg.tracks],
            "genes": cfg.genes_path,
            "defaultRef": cfg.default_ref,
            "defaultStart": cfg.default_start,
            "defaultEnd": cfg.default_end,
        }

    @app.get("/api/region")
    def api_region(
        ref: str,
        start: int = Query(..., ge=0),
        end: int = Query(..., ge=1),
        bins: int = Query(1200, ge=1, le=20000),
        track: list[str] = Query(default_factory=list),
        smooth: int = Query(1, ge=1, le=2001),
        spiky: float = Query(0.0, ge=0.0, le=10.0),
    ) -> dict[str, Any]:
        if end <= start:
            raise HTTPException(status_code=400, detail="end must be > start")
        if not track:
            # default: all configured tracks
            track = [t.id for t in cfg.tracks]

        spec_by_id = {t.id: t for t in cfg.tracks}
        missing = [t for t in track if t not in spec_by_id]
        if missing:
            raise HTTPException(status_code=400, detail=f"Unknown track ids: {missing}")

        reduce_mode = "mean"
        # If the user is viewing a very wide region, max helps preserve peaks.
        if (end - start) / max(1, bins) > 50:
            reduce_mode = "max"

        out_tracks: list[dict[str, Any]] = []
        signals = []
        errors: list[str] = []
        by_sample: dict[str, dict[str, Any]] = {}
        for tid in track:
            spec = spec_by_id[tid]
            try:
                sig = fetch_binned_track(
                    spec.source,
                    spec.strand,
                    ref=ref,
                    start=start,
                    end=end,
                    bins=bins,
                    reduce_mode=reduce_mode,
                    smooth=smooth,
                    spiky=spiky,
                )
                # Group plus/minus into one lane per sample name.
                slot = by_sample.get(spec.name)
                if slot is None:
                    slot = {
                        "id": spec.name,
                        "name": spec.name,
                        "color": spec.color,
                        "plus": np.zeros((bins,), dtype=np.float32),
                        "minus": np.zeros((bins,), dtype=np.float32),
                    }
                    by_sample[spec.name] = slot
                slot["plus"] = slot["plus"] + sig.plus.astype(np.float32, copy=False)
                slot["minus"] = slot["minus"] + sig.minus.astype(np.float32, copy=False)
            except Exception as e:
                errors.append(f"{spec.id}: {e}")

        if errors:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Failed to load one or more tracks",
                    "errors": errors,
                },
            )

        # Build final response lanes, and compute shared symmetric ymax across all samples.
        for sample in by_sample.values():
            sig = type("Tmp", (), {})()
            sig.plus = sample["plus"]
            sig.minus = sample["minus"]
            signals.append(sig)
            out_tracks.append(
                {
                    "id": sample["id"],
                    "name": sample["name"],
                    "color": sample["color"],
                    "plus": sample["plus"].tolist(),
                    "minus": sample["minus"].tolist(),
                }
            )

        y_max = shared_symmetric_ymax(signals)
        return {
            "ref": ref,
            "start": start,
            "end": end,
            "bins": bins,
            "yMax": y_max,
            "tracks": out_tracks,
        }

    @app.get("/api/genes")
    def api_genes(
        ref: str,
        start: int = Query(..., ge=0),
        end: int = Query(..., ge=1),
    ) -> dict[str, Any]:
        if end <= start:
            raise HTTPException(status_code=400, detail="end must be > start")
        if gene_index is None:
            return {"features": []}
        feats = gene_index.query(ref=ref, start=start, end=end)
        return {"features": [g.to_dict() for g in feats]}

    @app.get("/api/suggest")
    def api_suggest(
        prefix: str = Query(..., min_length=1),
        limit: int = Query(20, ge=1, le=50),
    ) -> dict[str, Any]:
        if gene_index is None:
            return {"suggestions": []}
        prefix = (prefix or "").strip()
        if not prefix:
            return {"suggestions": []}
        return {"suggestions": gene_index.suggest(prefix, limit=limit)}

    @app.get("/api/search")
    def api_search(q: str) -> dict[str, Any]:
        q = (q or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="Empty query")

        coord = parse_coordinate_query(q)
        if coord is not None:
            ref, start, end = coord
            return {"ref": ref, "start": start, "end": end}

        if gene_index is None:
            raise HTTPException(status_code=404, detail="No gene annotation loaded")
        g = gene_index.lookup(q)
        if g is None:
            raise HTTPException(status_code=404, detail="Gene not found")
        pad = max(2000, int((g.end - g.start) * 0.25))
        start = max(0, g.start - pad)
        end = g.end + pad
        return {"ref": g.ref, "start": start, "end": end}

    return app

