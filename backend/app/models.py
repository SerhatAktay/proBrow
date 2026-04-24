from __future__ import annotations

from pydantic import BaseModel, Field


class TrackSpec(BaseModel):
    id: str = Field(..., description="Unique track id used by the UI (e.g. sample1_plus)")
    name: str = Field(..., description="Human-readable track label")
    source: str = Field(..., description="Path or URL to bigWig file")
    strand: str = Field(..., description="'+' or '-' indicating which strand the bigWig represents")
    color: str | None = Field(None, description="CSS color for the track")

