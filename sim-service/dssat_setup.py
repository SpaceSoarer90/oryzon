"""Validate the DSSAT installation baked into the deployment image.

This is a startup check, not an installer. The executable is inspected directly
so this check does not depend on external ELF-inspection utilities.
"""
from __future__ import annotations

import os
import platform
import shutil
import struct
import subprocess
from pathlib import Path


def _has_elf_interpreter(executable: Path) -> bool:
    """Return whether an ELF executable has a PT_INTERP program header."""
    with executable.open("rb") as stream:
        ident = stream.read(16)
        if len(ident) != 16 or ident[:4] != b"\\x7fELF":
            raise RuntimeError(f"DSSAT executable is not an ELF binary: {executable}")

        elf_class, encoding = ident[4], ident[5]
        if elf_class not in (1, 2) or encoding not in (1, 2):
            raise RuntimeError(
                f"Unsupported ELF class/byte order in DSSAT executable: "
                f"class={elf_class}, encoding={encoding}"
            )

        endian = "<" if encoding == 1 else ">"
        if elf_class == 1:
            header_format = endian + "HHIIIIIHHHHHH"
            header_size = struct.calcsize(header_format)
            header = stream.read(header_size)
            if len(header) != header_size:
                raise RuntimeError("DSSAT ELF header is truncated")
            fields = struct.unpack(header_format, header)
            program_header_offset = fields[4]
            program_header_size = fields[8]
            program_header_count = fields[9]
            type_format = endian + "I"
        else:
            header_format = endian + "HHIQQQIHHHHHH"
            header_size = struct.calcsize(header_format)
            header = stream.read(header_size)
            if len(header) != header_size:
                raise RuntimeError("DSSAT ELF header is truncated")
            fields = struct.unpack(header_format, header)
            program_header_offset = fields[4]
            program_header_size = fields[8]
            program_header_count = fields[9]
            type_format = endian + "I"

        if program_header_size < struct.calcsize(type_format):
            raise RuntimeError("DSSAT ELF program-header entries are invalid")

        for index in range(program_header_count):
            stream.seek(program_header_offset + index * program_header_size)
            entry = stream.read(struct.calcsize(type_format))
            if len(entry) != struct.calcsize(type_format):
                raise RuntimeError("DSSAT ELF program headers are truncated")
            if struct.unpack(type_format, entry)[0] == 3:  # PT_INTERP
                return True

    return False


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

    if _has_elf_interpreter(executable):
        ldd = shutil.which("ldd")
        if ldd is None:
            raise RuntimeError(
                "ldd is unavailable; cannot validate DSSAT shared-library dependencies"
            )

        result = subprocess.run(
            [ldd, str(executable)],
            capture_output=True,
            text=True,
            check=False,
        )
        output = result.stdout + result.stderr
        if "not found" in output.lower():
            raise RuntimeError(
                "DSSAT has unresolved shared-library dependencies:\\n" + output
            )
        if result.returncode != 0:
            raise RuntimeError(
                f"could not inspect DSSAT shared libraries (exit {result.returncode}):\\n"
                + output
            )
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
