# proBrow

A lightweight, **local** genome browser for strand-specific PRO-seq signal stored in **bigWig** files, with gene annotations loaded from a **GTF** or a simple **TSV**.

Runs entirely on your machine — no cloud, no account, no data leaves your computer.

![proBrow screenshot](proBrow_Screenshot.png)

---

## Features

- **Strand-aware signal** — plus-strand in red, minus-strand in blue, stacked per sample
- **Auto-discovery** — point it at a folder of bigWigs and it infers strand and sample name from filenames
- **Built-in genomes** — `--genome hg38` downloads and caches a gene annotation automatically (no GTF hunting required)
- **GTF + TSV support** — full GTF/GFF3 parsing (with exon structure) or a simple 5-column TSV for custom annotations
- **Gene search** — type a gene name or coordinates (`chr1:1000-2000`) and jump instantly; current locus is always in the URL so you can copy and share it
- **Fast navigation** — pan, zoom, selection-zoom, hover crosshair with per-track values
- **Signal controls** — bp-aware smoothing, unsharp-mask sharpening, Y-scale, per-sample scale, bin density, all from the keyboard
- **Y-axis labels** — tick marks at 50 % and 100 % of the current scale on every lane
- **PNG export** — one click (or `e`) to save the current view as a PNG
- **Track management** — reorder, overlay, and ungroup tracks without reloading data
- **Config file** — save your usual flags in a TOML file and pass it with `--config`

---

## Requirements

- Python **≥ 3.10**
- `pip` (comes with Python)

No other tools need to be installed manually — the launch script creates and manages a virtual environment automatically.

---

## Quick start

```bash
git clone https://github.com/<your-username>/proBrow.git
cd proBrow

# With a built-in genome (downloads annotation on first use):
./probrow.sh --genome hg38 --bigwig-folder /path/to/bigwigs/

# Or with your own annotation file:
./probrow.sh --genes /path/to/genes.gtf --bigwig-folder /path/to/bigwigs/
```

The script will:  
1. Create a virtual environment under `backend/.venv/` on first run.  
2. Install all dependencies.  
3. Start the local server.  
4. Open the browser UI automatically.  

Stop the server with **Ctrl+C**.

---

## Inputs

### `--bigwig-folder`

Point proBrow at a folder (scanned recursively). It auto-detects:

- **Strand** from filename tokens: `plus / pos / fwd / forward` and `minus / neg / rev / reverse`
- **Sample name** by stripping those strand tokens from the filename

Files without a recognisable strand token are skipped.

### `--genome`

Download and cache a gene annotation automatically. The GTF is fetched on first use and stored in `~/.cache/probrow/genomes/` — subsequent runs reuse the cached file.

| Name | Assembly | Source |
|---|---|---|
| `hg38` | Human GRCh38 | Ensembl 113 |
| `hg19` | Human GRCh37 | Ensembl 87 |
| `hs1` | Human T2T CHM13v2 | UCSC ncbiRefSeq |
| `mm39` | Mouse GRCm39 | Ensembl 113 |
| `mm10` | Mouse GRCm38 | Ensembl 102 |
| `dm6` | Drosophila BDGP6 | Ensembl 113 |
| `ce11` | C. elegans WBcel235 | Ensembl 113 |
| `danRer11` | Zebrafish GRCz11 | Ensembl 113 |
| `sacCer3` | S. cerevisiae R64-1-1 | Ensembl 113 |

If `--genes` is also provided, it takes priority and `--genome` is ignored.

### `--genes`

Your own gene annotation file — either:

- **GTF / GFF3** (standard format, with `gene_id` / `gene_name` attributes; plain or `.gz`)
- **TSV** with columns: `chr`, `start`, `end`, `name`, `strand` (tab- or comma-separated; `strand` must be `+` or `-`)

### `--track` (explicit mode)

Provide one `--track` per bigWig instead of using `--bigwig-folder`:

```bash
./probrow.sh \
  --track "sampleA,/path/sampleA_plus.bw,+" \
  --track "sampleA,/path/sampleA_minus.bw,-" \
  --genome hg38
```

Format: `name,/path/to/file.bw,strand` where strand is `+` or `-`.

### `--config` (config file)

Save your usual flags in a TOML file so you don't have to retype them:

```toml
# probrow.toml
genome        = "hg38"
bigwig_folder = "/data/my_project/bigwigs"

# Optional: explicit tracks instead of bigwig_folder
# [[tracks]]
# name   = "WT_rep1"
# source = "/data/WT_rep1_plus.bw"
# strand = "+"
```

Then launch with:

```bash
./probrow.sh --config probrow.toml
```

CLI flags always take priority over config file values. Config files require Python ≥ 3.11, or install `tomli` on Python 3.10:

```bash
pip install -e "backend/.[config]"
```

### URL sharing

The browser URL is updated automatically as you navigate — copy and paste it to share an exact locus with a colleague (works as long as they have access to the same proBrow server).

---

## CLI reference

```
./probrow.sh --help
```

| Flag | Description |
|---|---|
| `--bigwig-folder PATH` | Folder to scan for bigWig files |
| `--track NAME,PATH,STRAND` | Explicit track (repeatable) |
| `--genes PATH` | GTF/GFF3 or TSV annotation file |
| `--genome NAME` | Built-in genome annotation (downloads on first use) |
| `--host HOST` | Bind host (default: `127.0.0.1`) |
| `--port PORT` | Port (default: `0` = random free port) |
| `--config PATH` | TOML config file (CLI flags take priority) |
| `--no-open` | Don't open a browser tab automatically |
| `--verbose` | Print server access logs |
| `--version` | Print version and exit |

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| Click + drag | Pan |
| Scroll / `+` / `-` | Zoom in/out |
| Shift + drag | Selection zoom |
| `[` / `]` | Scale Y down/up |
| `a` | Auto-scale Y to current view |
| `s` / `S` | Smooth less/more (bp-aware, up to 20 kb window) |
| `k` / `K` | Sharpen less/more (unsharp mask) |
| `p` | Toggle per-sample Y scale |
| `b` / `B` | Fewer/more bins (performance vs. detail) |
| `e` | Export current view as PNG |
| `?` or `h` | Toggle shortcut help panel |

Click **Tracks** in the toolbar to reorder, overlay, or ungroup tracks. Click **Export PNG** in the toolbar to save the current view.

---

## Optional: shell autocomplete

```bash
cd backend
source .venv/bin/activate
pip install -e ".[autocomplete]"

# zsh
autoload -U bashcompinit && bashcompinit
eval "$(register-python-argcomplete probrow)"

# bash
eval "$(register-python-argcomplete probrow)"
```

---

## Project structure

```
proBrow/
├── probrow.sh              # Launch script (sets up venv, starts server)
├── backend/
│   ├── pyproject.toml      # Package metadata and dependencies
│   ├── bootstrap.sh        # Venv creation and install logic
│   └── app/
│       ├── cli.py          # Argument parsing, genome registry, server startup
│       ├── main.py         # FastAPI app and API endpoints
│       ├── config.py       # AppConfig and track color defaults
│       ├── genes.py        # GTF/TSV parser and gene index
│       ├── signal.py       # bigWig reading, binning, and smoothing
│       ├── models.py       # Pydantic models (TrackSpec)
│       └── static/         # Frontend (HTML + vanilla JS + CSS)
└── LICENSE
```

---

## License

[MIT](LICENSE)
