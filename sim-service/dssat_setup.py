"""Validate the DSSAT installation baked into the deployment image.

This is a startup check, not an installer: Docker builds DSSAT from source so the
executable is linked against the same GLIBC family as the Python runtime.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )


def validate_dssat() -> None:
    home = Path(os.environ.get("ORYZON_DSSAT_HOME", "/opt/dssat")).expanduser().resolve()
    executable = home / "dscsm048"
    required = (
        executable,
        home / "DSSATPRO.L48",
        home / "Genotype" / "RICER048.CUL",
        home / "DSSAT_VERSION",
    )

    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("DSSAT image is incomplete; missing: " + ", ".join(missing))

    if not os.access(executable, os.X_OK):
        raise RuntimeError(f"DSSAT executable is not executable: {executable}")

    # Inspect the ELF headers first. ldd reports "not a dynamic executable"
    # for valid statically linked ELF binaries, so its exit status alone is
    # not enough to decide whether the DSSAT build is broken.
    readelf = shutil.which("readelf")
    if readelf is None:
        raise RuntimeError("readelf is unavailable; cannot validate DSSAT executable")

    header = _run([readelf, "-h", str(executable)])
    if header.returncode != 0 or "ELF" not in header.stdout:
        output = header.stdout + header.stderr
        raise RuntimeError(f"DSSAT executable is not a valid ELF binary:\n{output}")

    program_headers = _run([readelf, "-l", str(executable)])
    if program_headers.returncode != 0:
        output = program_headers.stdout + program_headers.stderr
        raise RuntimeError(f"could not inspect DSSAT ELF program headers:\n{output}")

    # A PT_INTERP segment means the executable uses a dynamic loader and ldd
    # can resolve its shared libraries. Without it, treat the ELF as static
    # (or static-PIE) and do not pass it to ldd.
    dynamically_linked = "INTERP" in program_headers.stdout
    if dynamically_linked:
        ldd = shutil.which("ldd")
        if ldd is None:
            raise RuntimeError("ldd is unavailable; cannot validate DSSAT shared libraries")

        result = _run([ldd, str(executable)])
        output = result.stdout + result.stderr
        if "not found" in output.lower():
            raise RuntimeError(
                "DSSAT has unresolved shared-library dependencies:\n" + output
            )
        if result.returncode != 0:
            raise RuntimeError(f"could not inspect DSSAT shared libraries:\n{output}")
    else:
        print(
            "DSSAT executable has no ELF interpreter; "
            "skipping shared-library inspection (static executable).",
            flush=True,
        )

    version = (home / "DSSAT_VERSION").read_text().strip()
    build_ref = (
        (home / "DSSAT_BUILD_REF").read_text().strip()
        if (home / "DSSAT_BUILD_REF").exists()
        else "unknown"
    )
    print(
        "DSSAT runtime validated: "
        f"version={version}, source_ref={build_ref}, "
        f"libc={platform.libc_ver()}, executable={executable}",
        flush=True,
    )


if __name__ == "__main__":
    validate_dssat()
