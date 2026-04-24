from __future__ import annotations

import gzip
import re
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


def _open_text(path: Path):
    """Open a plain or gzip-compressed text file for reading."""
    if path.name.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


@dataclass(frozen=True)
class GeneFeature:
    ref: str
    start: int
    end: int
    name: str
    strand: str
    gene_id: str | None = None
    exons: tuple[tuple[int, int], ...] | None = None

    def to_dict(self) -> dict:
        return {
            "ref": self.ref,
            "start": self.start,
            "end": self.end,
            "name": self.name,
            "strand": self.strand,
            "id": self.gene_id,
            "exons": [list(x) for x in self.exons] if self.exons else None,
        }


_coord_pat = re.compile(
    r"^(?P<ref>[^:]+):(?P<start>[\d,]+)(?:-(?P<end>[\d,]+))?$", re.IGNORECASE
)


def parse_coordinate_query(q: str) -> tuple[str, int, int] | None:
    m = _coord_pat.match(q.replace(" ", ""))
    if not m:
        return None
    ref = m.group("ref")
    start_s = m.group("start").replace(",", "")
    end_s = (m.group("end") or "").replace(",", "")
    start = int(start_s)
    end = int(end_s) if end_s else start + 1
    if start < 0:
        start = 0
    if end <= start:
        end = start + 1
    return ref, start, end


def _iter_tsv(path: Path) -> Iterator[GeneFeature]:
    # Expect: chr, start, end, name, strand (tab or comma separated)
    with _open_text(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = re.split(r"[\t,]+", line)
            if len(parts) < 5:
                continue
            ref, start_s, end_s, name, strand = parts[:5]
            try:
                start = int(start_s)
                end = int(end_s)
            except ValueError:
                continue
            if strand not in {"+", "-"}:
                strand = "+"
            if end <= start:
                continue
            yield GeneFeature(ref=ref, start=start, end=end, name=name, strand=strand)


def _parse_gtf_attrs(attr_field: str) -> dict[str, str]:
    # Minimal-but-robust attributes parsing for GTF/GFF3-ish fields.
    # Supports:
    # - GTF: key "value";
    # - GFF3: key=value;key2=value2
    out: dict[str, str] = {}
    for part in attr_field.strip().strip(";").split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" in part and " " not in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
            continue
        if " " in part:
            k, v = part.split(" ", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def _iter_gtf(path: Path) -> Iterator[GeneFeature]:
    # Many annotations omit explicit `feature=gene` and only include transcript/exon.
    # We build gene bounds by aggregating anything with a gene_id/Parent.
    bounds: dict[str, tuple[str, int, int, str, str]] = {}
    # gene_id -> (ref, min_start, max_end, strand, name)
    exons: dict[str, list[tuple[int, int]]] = {}

    with _open_text(path) as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            ref, _source, feature, start_s, end_s, _score, strand, _frame, attrs = parts
            if feature not in {"gene", "transcript", "exon", "mRNA"}:
                continue
            try:
                start = int(start_s) - 1  # 1-based inclusive -> 0-based half-open
                end = int(end_s)
            except ValueError:
                continue
            if end <= start:
                continue
            a = _parse_gtf_attrs(attrs)
            gene_id = a.get("gene_id") or a.get("gene") or a.get("ID") or a.get("Parent")
            if not gene_id:
                continue
            name = a.get("gene_name") or a.get("Name") or a.get("gene") or gene_id
            if strand not in {"+", "-"}:
                strand = "+"

            if feature == "exon":
                exons.setdefault(gene_id, []).append((start, end))

            cur = bounds.get(gene_id)
            if cur is None:
                bounds[gene_id] = (ref, start, end, strand, name)
            else:
                ref0, s0, e0, strand0, name0 = cur
                # prefer existing name0 if it's not just the id
                final_name = name0 if name0 and name0 != gene_id else name
                bounds[gene_id] = (ref0, min(s0, start), max(e0, end), strand0, final_name)

    for gene_id, (ref, start, end, strand, name) in bounds.items():
        xs = exons.get(gene_id) or []
        # Normalize exon intervals: sort, merge overlaps, and clip to gene bounds.
        if xs:
            xs = [(max(start, s), min(end, e)) for (s, e) in xs if e > s]
            xs.sort()
            merged: list[tuple[int, int]] = []
            for s, e in xs:
                if not merged or s > merged[-1][1]:
                    merged.append((s, e))
                else:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], e))
            exon_t = tuple(merged)
        else:
            exon_t = None
        yield GeneFeature(
            ref=ref,
            start=start,
            end=end,
            name=name,
            strand=strand,
            gene_id=gene_id,
            exons=exon_t,
        )


def iter_features(path: str) -> Iterator[GeneFeature]:
    p = Path(path).expanduser()
    if not p.exists():
        return iter(())
    lower = p.name.lower()
    if lower.endswith(".gtf") or lower.endswith(".gtf.gz") or lower.endswith(".gff") or lower.endswith(".gff3"):
        return _iter_gtf(p)
    return _iter_tsv(p)


class GeneIndex:
    def __init__(self, features: Iterable[GeneFeature]):
        by_ref: dict[str, list[GeneFeature]] = {}
        by_name: dict[str, GeneFeature] = {}

        for g in features:
            by_ref.setdefault(g.ref, []).append(g)
            key = g.name.strip().lower()
            if key and key not in by_name:
                by_name[key] = g
            if g.gene_id:
                gid = g.gene_id.strip().lower()
                if gid and gid not in by_name:
                    by_name[gid] = g

        for ref, arr in by_ref.items():
            arr.sort(key=lambda x: x.start)
            by_ref[ref] = arr

        self._by_ref = by_ref
        self._by_name = by_name
        self._name_keys_sorted = sorted(self._by_name.keys())

    def _canonical_suggestion_value(self, g: GeneFeature, key_lower: str) -> str:
        # Prefer returning the original gene name casing, but if the key actually
        # matches the gene_id, keep the id (common for IDs like ENSG...).
        if g.name and g.name.strip() and g.name.lower() == key_lower:
            return g.name
        if g.gene_id and g.gene_id.strip() and g.gene_id.lower() == key_lower:
            return g.gene_id
        return g.name or g.gene_id or key_lower

    def suggest(self, prefix: str, limit: int = 20) -> list[dict]:
        p = (prefix or "").strip().lower()
        if not p:
            return []
        keys = self._name_keys_sorted
        # Find all keys starting with `p` using range search.
        start = bisect_left(keys, p)
        end = bisect_left(keys, p + "\uffff")
        out: list[dict] = []
        seen: set[str] = set()
        for k in keys[start:end]:
            g = self._by_name.get(k)
            if g is None:
                continue
            val = self._canonical_suggestion_value(g, k)
            if not val:
                continue
            key = val.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append({"label": val, "value": val, "id": g.gene_id})
            if len(out) >= limit:
                break
        return out

    @classmethod
    def from_path(cls, path: str | None) -> "GeneIndex | None":
        if not path:
            return None
        feats = iter_features(path)
        return cls(feats)

    def query(self, ref: str, start: int, end: int, limit: int = 500) -> list[GeneFeature]:
        arr = self._by_ref.get(ref, [])
        if not arr:
            return []
        # scan from the first feature with start >= start, but include overlaps that begin before start
        starts = [g.start for g in arr]
        i = max(0, bisect_left(starts, start) - 1)
        out: list[GeneFeature] = []
        for g in arr[i:]:
            if g.start >= end:
                break
            if g.end > start:
                out.append(g)
                if len(out) >= limit:
                    break
        return out

    def lookup(self, name_or_id: str) -> GeneFeature | None:
        key = name_or_id.strip().lower()
        if not key:
            return None
        return self._by_name.get(key)

