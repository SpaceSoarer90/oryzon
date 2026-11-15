"""Run original DSSAT FileX experiments placed beside the service.

The recommendation pipeline generates its own RIX files. This module is separate:
it stages a user's original .MZX/.SBX/.TMX/.RIX (or other three-letter extension
ending in X) unchanged and invokes DSSAT batch mode on that file.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path

import config

_TIMEOUT = int(os.environ.get("ORYZON_FILEX_TIMEOUT_S", "600"))


def _is_filex(path: Path) -> bool:
    ext = path.suffix.upper()
    return path.is_file() and len(ext) == 4 and ext.endswith("X")


def _details(path: Path) -> str:
    for line in path.read_text(errors="replace").splitlines():
        if line.upper().startswith("*EXP.DETAILS:"):
            return line.split(":", 1)[1].strip()
    return path.stem


def _field_value(path: Path, column: str) -> str | None:
    in_fields = False
    lines = path.read_text(errors="replace").splitlines()
    for i, line in enumerate(lines):
        if line.startswith("*"):
            in_fields = line[1:].strip().upper().startswith("FIELDS")
            continue
        if not in_fields or not line.startswith("@"):
            continue
        headers = [token.split(".", 1)[0] for token in line[1:].split()]
        if column not in headers:
            continue
        for row in lines[i + 1:]:
            if row.startswith("*"):
                break
            if not row.strip() or row.startswith("@"):
                continue
            values = row.split()
            index = headers.index(column)
            return values[index] if index < len(values) else None
    return None


def discover_filex(directory: Path) -> list[dict]:
    """List DSSAT FileX files; unrelated documentation and data files are ignored."""
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.iterdir()):
        if not _is_filex(path):
            continue
        ext = path.suffix[1:].upper()
        out.append({
            "filename": path.name,
            "experiment_id": path.stem,
            "crop_code": ext[:-1],
            "title": _details(path),
        })
    return out


def run_filex(runner, directory: Path, filename: str) -> dict:
    """Stage and run one catalogued FileX without changing its contents.

    Put the experiment's required WTH and (if not in the configured soil store) SOL
    file beside it. Crop genotype files remain in DSSAT_HOME/Genotype and are found
    through DSSATPRO.L48.
    """
    if Path(filename).name != filename:
        raise ValueError("filename must be a basename, not a path")
    source = directory / filename
    if not _is_filex(source):
        raise FileNotFoundError(f"no DSSAT FileX named {filename!r} in {directory}")
    station = _field_value(source, "WSTA")
    soil_id = _field_value(source, "ID_SOIL")
    if not station or station == "-99":
        raise ValueError(f"{filename}: FIELDS section has no usable WSTA weather station")
    if not soil_id or soil_id == "-99":
        raise ValueError(f"{filename}: FIELDS section has no usable ID_SOIL")

    work_root = config.DSSAT_DIR / "filex-runs"
    work_root.mkdir(parents=True, exist_ok=True)
    work_dir = work_root / f"{source.stem}-{uuid.uuid4().hex[:10]}"
    work_dir.mkdir(parents=True)
    shutil.copy2(source, work_dir / source.name)

    profile = runner.home / "DSSATPRO.L48"
    if not profile.exists():
        raise RuntimeError(f"DSSAT path profile missing: {profile}")
    profile_text = profile.read_text(errors="replace")
    if "/usr/local" in profile_text:
        profile_text = profile_text.replace("/usr/local", str(runner.home))
    (work_dir / "DSSATPRO.L48").write_text(profile_text)

    # User-supplied support data lives alongside the FileX.
    for dep in directory.iterdir():
        if dep.is_file() and dep.suffix.upper() in {".WTH", ".SOL"}:
            shutil.copy2(dep, work_dir / dep.name)

    wth = [p for p in work_dir.glob("*.WTH") if p.name.upper().startswith(station.upper())]
    if not wth:
        weather_root = runner.home / "Weather"
        if weather_root.is_dir():
            for dep in weather_root.rglob("*.WTH"):
                if dep.name.upper().startswith(station.upper()):
                    shutil.copy2(dep, work_dir / dep.name)
            wth = [p for p in work_dir.glob("*.WTH") if p.name.upper().startswith(station.upper())]
    if not wth:
        raise ValueError(
            f"{filename} references WSTA={station}, but no matching {station}*.WTH was found. "
            f"Place the required weather file(s) beside the experiment in {directory}.")

    soil_prefix = soil_id[:2].upper()
    if not any(p.name.upper() == f"{soil_prefix}.SOL" for p in work_dir.glob("*.SOL")):
        soil_source = Path(config.SOIL_FILE)
        if not soil_source.exists():
            raise ValueError(
                f"{filename} references ID_SOIL={soil_id}; no {soil_prefix}.SOL was supplied "
                "and the configured soil file is unavailable.")
        shutil.copy2(soil_source, work_dir / f"{soil_prefix}.SOL")

    try:
        proc = subprocess.run(
            [str(runner.exe), "A", source.name],
            cwd=work_dir, capture_output=True, text=True, timeout=_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"DSSAT timed out after {_TIMEOUT}s; work files retained at {work_dir}") from exc

    (work_dir / "dssat.stdout.log").write_text(proc.stdout + "\n" + proc.stderr)
    outputs = sorted(p.name for p in work_dir.iterdir()
                     if p.is_file() and p.suffix.upper() in {".OUT", ".LOG"})
    diagnostics = ""
    for name in ("ERROR.OUT", "WARNING.OUT"):
        p = work_dir / name
        if p.exists():
            diagnostics += p.read_text(errors="replace")[-4000:]
    return {
        "filename": source.name,
        "crop_code": source.suffix[1:-1].upper(),
        "exit_code": proc.returncode,
        "summary_available": (work_dir / "Summary.OUT").exists(),
        "outputs": outputs,
        "diagnostics": diagnostics[-8000:],
        "stdout": (proc.stdout + "\n" + proc.stderr)[-8000:],
        "work_dir": str(work_dir),
    }
