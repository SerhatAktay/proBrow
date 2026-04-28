from __future__ import annotations

import argparse
import os
import re
import socket
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from .config import load_config_from_args
from .main import create_app

# ---------------------------------------------------------------------------
# Built-in genome registry
# ---------------------------------------------------------------------------

_GENOME_REGISTRY: dict[str, dict[str, str]] = {
    "hg38": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/homo_sapiens/Homo_sapiens.GRCh38.113.gtf.gz",
        "description": "Human GRCh38 / hg38 (Ensembl 113)",
    },
    "hg19": {
        "url": "https://ftp.ensembl.org/pub/grch37/release-87/gtf/homo_sapiens/Homo_sapiens.GRCh37.87.gtf.gz",
        "description": "Human GRCh37 / hg19 (Ensembl 87)",
    },
    "hs1": {
        "url": "https://hgdownload.soe.ucsc.edu/goldenPath/hs1/bigZips/genes/hs1.ncbiRefSeq.gtf.gz",
        "description": "Human T2T CHM13v2 / hs1 (UCSC ncbiRefSeq)",
    },
    "mm39": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/mus_musculus/Mus_musculus.GRCm39.113.gtf.gz",
        "description": "Mouse GRCm39 / mm39 (Ensembl 113)",
    },
    "mm10": {
        "url": "https://ftp.ensembl.org/pub/release-102/gtf/mus_musculus/Mus_musculus.GRCm38.102.gtf.gz",
        "description": "Mouse GRCm38 / mm10 (Ensembl 102)",
    },
    "dm6": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/drosophila_melanogaster/Drosophila_melanogaster.BDGP6.46.113.gtf.gz",
        "description": "Drosophila melanogaster BDGP6 / dm6 (Ensembl 113)",
    },
    "ce11": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/caenorhabditis_elegans/Caenorhabditis_elegans.WBcel235.113.gtf.gz",
        "description": "C. elegans WBcel235 / ce11 (Ensembl 113)",
    },
    "danRer11": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/danio_rerio/Danio_rerio.GRCz11.113.gtf.gz",
        "description": "Zebrafish GRCz11 / danRer11 (Ensembl 113)",
    },
    "sacCer3": {
        "url": "https://ftp.ensembl.org/pub/release-113/gtf/saccharomyces_cerevisiae/Saccharomyces_cerevisiae.R64-1-1.113.gtf.gz",
        "description": "S. cerevisiae R64-1-1 / sacCer3 (Ensembl 113)",
    },
}


def _genome_cache_dir() -> Path:
    d = Path.home() / ".cache" / "probrow" / "genomes"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fetch_genome_gtf(genome: str) -> str:
    """
    Return the path to a locally cached GTF for the given genome identifier,
    downloading it from the registry URL on first use.
    """
    entry = _GENOME_REGISTRY.get(genome)
    if entry is None:
        valid = ", ".join(sorted(_GENOME_REGISTRY))
        raise SystemExit(
            f"error: unknown genome '{genome}'.\nAvailable genomes: {valid}"
        )

    url = entry["url"]
    filename = url.rsplit("/", 1)[-1]
    dest = _genome_cache_dir() / filename

    if dest.exists():
        print(f"Using cached annotation for {genome}: {dest}")
        return str(dest)

    print(f"Downloading annotation: {entry['description']}")
    print(f"  Source : {url}")
    print(f"  Cache  : {dest}")

    tmp = dest.with_suffix(".tmp")
    try:
        def _progress(count: int, block: int, total: int) -> None:
            if total > 0:
                pct = min(100, count * block * 100 // total)
                mb = count * block / 1_048_576
                print(f"\r  {pct:3d}%  {mb:.1f} MB", end="", flush=True)

        urllib.request.urlretrieve(url, str(tmp), reporthook=_progress)
        print()  # newline after progress bar
        tmp.rename(dest)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"error: download failed: {exc}") from exc

    print(f"Done — annotation cached at {dest}\n")
    return str(dest)


# ---------------------------------------------------------------------------
# Config file
# ---------------------------------------------------------------------------

def _load_config_file(path: str) -> dict:
    """
    Load a TOML config file and return its contents as a dict.
    Requires Python >= 3.11 (stdlib tomllib) or the 'tomli' package on 3.10.
    """
    try:
        import tomllib  # stdlib, Python >= 3.11
    except ImportError:
        try:
            import tomli as tomllib  # type: ignore  # pip install tomli
        except ImportError:
            raise SystemExit(
                "error: reading config files requires Python ≥ 3.11 or the 'tomli' package.\n"
                "Install it with: pip install -e 'backend/.[config]'"
            )
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(f"error: config file not found: {path}")
    with open(p, "rb") as f:
        return tomllib.load(f)


# ---------------------------------------------------------------------------
# Track helpers
# ---------------------------------------------------------------------------

def _parse_track(value: str) -> tuple[str, str, str]:
    """
    Parse --track 'name,source,strand' where strand is '+' or '-'.
    """
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(
            "Track must be 'name,source,strand' (e.g. 'sampleA,/path/a.bw,+')"
        )
    name, source, strand = parts
    if strand not in {"+", "-"}:
        raise argparse.ArgumentTypeError("Strand must be '+' or '-'")
    return name, source, strand


def _pick_port(preferred: int) -> int:
    if preferred != 0:
        return preferred
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return int(port)


_PLUS_TOKENS = {"plus", "pos", "positive", "pl", "fwd", "forward"}
_MINUS_TOKENS = {"minus", "min", "neg", "negative", "rev", "reverse"}


def _tokenize_filename(name: str) -> list[str]:
    base = re.sub(r"\.(bw|bigwig)$", "", name, flags=re.IGNORECASE)
    return [t for t in re.split(r"[^a-zA-Z0-9]+", base.lower()) if t]


def _detect_strand_from_tokens(tokens: list[str]) -> str | None:
    if any(t in _PLUS_TOKENS for t in tokens):
        return "+"
    if any(t in _MINUS_TOKENS for t in tokens):
        return "-"
    return None


def _sample_name_from_tokens(tokens: list[str]) -> str:
    # remove strand tokens and some generic words
    drop = _PLUS_TOKENS | _MINUS_TOKENS | {"strand", "stranded", "bw", "bigwig", "wig"}
    kept = [t for t in tokens if t not in drop]
    return "_".join(kept) if kept else "sample"


def discover_tracks_in_folder(folder: str) -> list[tuple[str, str, str]]:
    p = Path(folder).expanduser()
    if not p.exists() or not p.is_dir():
        raise argparse.ArgumentTypeError(f"Not a folder: {folder}")
    out: list[tuple[str, str, str]] = []
    for child in sorted(p.rglob("*")):
        if not child.is_file():
            continue
        if child.suffix.lower() not in {".bw", ".bigwig"}:
            continue
        tokens = _tokenize_filename(child.name)
        strand = _detect_strand_from_tokens(tokens)
        if strand is None:
            continue
        sample = _sample_name_from_tokens(tokens)
        out.append((sample, str(child), strand))
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    genome_list = ", ".join(sorted(_GENOME_REGISTRY))

    parser = argparse.ArgumentParser(prog="probrow")
    parser.add_argument("--version", action="version", version="%(prog)s 0.1.0")
    parser.add_argument(
        "--config",
        default=None,
        metavar="PATH",
        help=(
            "Path to a TOML config file. CLI flags take priority over config values. "
            "Requires Python ≥ 3.11 or: pip install -e 'backend/.[config]'"
        ),
    )
    parser.add_argument(
        "--track",
        action="append",
        type=_parse_track,
        default=[],
        help="Repeatable: 'name,source,strand' (strand is + or -). Source can be local path or URL.",
    )
    parser.add_argument(
        "--genes",
        default=None,
        help="Gene annotation file: GTF/GFF3 or TSV with columns chr,start,end,name,strand.",
    )
    parser.add_argument(
        "-g", "--genome",
        default=None,
        metavar="NAME",
        help=(
            "Built-in genome to use for gene annotations — downloads and caches the GTF on first use. "
            f"Available: {genome_list}. Ignored if --genes is also provided."
        ),
    )
    parser.add_argument(
        "-i", "--bigwig-folder",
        default=None,
        help="Folder containing .bw/.bigWig files; auto-detect plus/minus from filenames and pair by sample name.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 picks a random free port")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser tab")
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Verbose server logs (uvicorn info + access logs).",
    )

    # Optional shell autocomplete (argcomplete). Safe if not installed.
    try:
        import argcomplete  # type: ignore

        argcomplete.autocomplete(parser)
    except Exception:
        pass

    args = parser.parse_args()

    # Apply config file values for anything not already supplied on the CLI.
    if args.config:
        cfg = _load_config_file(args.config)
        if not args.genes and not args.genome:
            args.genes = cfg.get("genes")
            args.genome = cfg.get("genome")
        if not args.bigwig_folder:
            args.bigwig_folder = cfg.get("bigwig_folder")
        if not args.track:
            for t in cfg.get("tracks", []):
                try:
                    args.track.append((str(t["name"]), str(t["source"]), str(t["strand"])))
                except KeyError as exc:
                    raise SystemExit(f"error: config track missing field {exc}") from exc

    # If paths are relative, resolve them relative to the directory where the user invoked
    # the command (not necessarily the current working directory if a wrapper script `cd`s).
    invoke_cwd = os.environ.get("PROBROW_INVOKE_CWD") or os.getcwd()
    if args.genes and not os.path.isabs(args.genes):
        args.genes = str(Path(invoke_cwd, args.genes))
    if args.bigwig_folder and not os.path.isabs(args.bigwig_folder):
        args.bigwig_folder = str(Path(invoke_cwd, args.bigwig_folder))

    # Resolve gene annotation: --genes takes priority; fall back to --genome.
    if args.genes:
        if args.genome:
            print("Note: --genome is ignored because --genes was also provided.")
    elif args.genome:
        args.genes = _fetch_genome_gtf(args.genome)
    else:
        print("Note: no gene annotation loaded. Use --genes or --genome to enable gene search and display.")

    tracks = list(args.track)
    if args.bigwig_folder:
        tracks.extend(discover_tracks_in_folder(args.bigwig_folder))

    if not tracks:
        parser.error(
            "Provide at least one --track or --bigwig-folder. Example: --track 'sampleA,/path/sampleA_plus.bw,+'"
        )

    cfg = load_config_from_args(tracks, args.genes)
    app = create_app(cfg)

    port = _pick_port(args.port)
    url = f"http://{args.host}:{port}/"
    if not args.no_open:
        webbrowser.open(url)

    uvicorn.run(
        app,
        host=args.host,
        port=port,
        log_level="info" if args.verbose else "warning",
        access_log=bool(args.verbose),
    )


if __name__ == "__main__":
    main()
