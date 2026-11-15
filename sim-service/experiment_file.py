"""DSSAT FileX (.RIX) parser and emitter.

The selectable rice experiments live in EXPERIMENTS_DIR (config) as .RIX files —
complete FileX experiments (genetics + soil + initial conditions + management +
simulation controls). Per the project owner's decisions (AUDIT.md §9):

- A selected file is a MANAGEMENT PRESET: the app still enumerates calibrated
  varieties, still runs the weather-ensemble scenarios, and still ranks by RY.
- Rebasing + farm-aware: the file's dates are shifted onto the chosen planting
  date (intervals preserved); weather comes from the farm's scenario record;
  soil comes from the nearest PH.SOL profile (the file's ID_SOIL is overridden).
- Every actual/ideal run emits its own .RIX into its isolated work directory,
  with the overrides applied (and WATER/NITRO forced off for ideal runs).

DSSAT FileX layout used here (matches the owner's files): `*SECTION` headers,
`@`-prefixed header rows naming the columns, whitespace-separated data rows.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

# DSSAT two-digit-year windowing (>= 51 -> 19xx, else 20xx), used only to make
# file dates comparable; absolute year is irrelevant because dates are rebased.
def _yyddd_to_date(code: int) -> date | None:
    s = str(code).zfill(5)
    yy, ddd = int(s[:2]), int(s[2:])
    return date(2000 + yy if yy < 51 else 1900 + yy, 1, 1) + timedelta(days=ddd - 1)


def _date_to_yyddd(d: date) -> str:
    return f"{d.year % 100:02d}{d.timetuple().tm_yday:03d}"


@dataclass(frozen=True)
class ExperimentPreset:
    """The management package extracted from a .RIX file. Dates keep their
    original (file) values; rebasing happens per scenario in the orchestrator."""
    experiment_id: str          # file stem, e.g. ARYZ0000
    title: str                  # from *EXP.DETAILS
    cultivar: str               # INGENO, e.g. IB0015
    cultivar_name: str          # CNAME, e.g. "IR 64"
    soil_id: str | None         # file's ID_SOIL (overridden by farm-aware mode)
    planting: dict              # PDATE/EDATE/PPOP/PPOE/PLME/PLDS/PLRS/PLRD/PLDP...
    irrigation: tuple[dict, ...]        # IDATE/IROP/IRVAL rows
    fertilizer: tuple[dict, ...]        # FDATE/FMCD/FACD/DEP/AMN... rows
    initial_conditions: tuple[dict, ...]  # PCR/ICDAT + ICBL/SH2O/SNH4/SNO3 rows
    controls: dict              # GENERAL/OPTIONS/METHODS/MANAGEMENT/OUTPUTS rows
    auto: dict                  # AUTOMATIC MANAGEMENT sub-tables (PLANTING/IRRIGATION/...)

    @property
    def establishment(self) -> str:
        """SeasonSpec establishment code: PLME T = transplanted, S = direct-seeded."""
        return "T" if str(self.planting.get("PLME", "S")).upper() == "T" else "DS"

    @property
    def planting_date(self) -> date | None:
        try:
            return _yyddd_to_date(int(self.planting["PDATE"]))
        except (KeyError, TypeError, ValueError):
            return None


def parse_filex(path: Path) -> ExperimentPreset:
    """Parse the sections the preset needs out of a .RIX file."""
    sections: dict[str, list[tuple[list[str], list[str]]]] = {}
    current: str | None = None
    header: list[str] | None = None
    rows: list[list[str]] = []
    title = ""

    for raw in path.read_text(errors="replace").splitlines():
        line = raw.rstrip()
        if line.startswith("*EXP.DETAILS:"):
            title = line[len("*EXP.DETAILS:"):].strip()
            parts = title.split()
            title = " ".join(parts[2:]) if len(parts) > 2 else title   # drop ID + "RI"
            continue
        if line.startswith("*"):
            if current and header is not None:
                sections.setdefault(current, []).append((header, rows))
            current, header, rows = line[1:].split()[0].rstrip("()"), None, []
            continue
        if line.startswith("@"):
            if current and header is not None:
                sections.setdefault(current, []).append((header, rows))
                header, rows = None, []
            header = [t for t in line[1:].split() if t.isupper() or t in ("PCR", "ICBL")]
            rows = []
            continue
        if current is None or header is None:
            continue
        if not line.strip():
            header, rows = None, []
            continue
        rows.append(line.split())
    if current and header is not None:
        sections.setdefault(current, []).append((header, rows))

    def first_row(section: str, cols: list[str]) -> dict:
        """First data row of a section as {COLUMN: value}, by header-token position."""
        for hdr, rows in sections.get(section, []):
            for r in rows:
                return {c: (r[i] if i < len(r) else "-99") for i, c in enumerate(hdr) if _col(c)}
        return {c: "-99" for c in cols}

    def table(section: str, key_cols: tuple[str, ...]) -> list[dict]:
        """All data rows of the LAST table in a section (multi-table sections repeat
        their @ headers, e.g. IRRIGATION and AUTOMATIC MANAGEMENT)."""
        blocks = sections.get(section, [])
        if not blocks:
            return []
        hdr, rows = blocks[-1]
        out = []
        for r in rows:
            if len(r) < len(hdr):
                continue
            row = {c: r[i] for i, c in enumerate(hdr) if _col(c)}
            if any(c in row for c in key_cols):
                out.append(row)
        return out

    cultivars = first_row("CULTIVARS", ["C", "CR", "INGENO", "CNAME"])
    fields = first_row("FIELDS", ["ID_FIELD", "ID_SOIL"])
    planting = first_row("PLANTING", ["PDATE", "PLME"])
    controls: dict = {}
    for sub in ("GENERAL", "OPTIONS", "METHODS", "MANAGEMENT", "OUTPUTS"):
        row = first_row(sub, [])
        if row:
            controls.update(row)
    ic_header_rows = sections.get("INITIAL CONDITIONS", [])
    ic_rows: list[dict] = []
    if ic_header_rows:
        hdr, rows = ic_header_rows[-1]
        ic_rows = [{c: r[i] for i, c in enumerate(hdr) if _col(c)} for r in rows
                   if len(r) == len(hdr) and "ICBL" in hdr]

    return ExperimentPreset(
        experiment_id=path.stem,
        title=title,
        cultivar=cultivars.get("INGENO", "-99"),
        cultivar_name=cultivars.get("CNAME", ""),
        soil_id=fields.get("ID_SOIL") if fields.get("ID_SOIL", "-99") != "-99" else None,
        planting=planting,
        irrigation=tuple(table("IRRIGATION", ("IDATE", "IRVAL"))),
        fertilizer=tuple(table("FERTILIZERS", ("FDATE", "FAMN"))),
        initial_conditions=tuple(ic_rows),
        controls=controls,
        auto=_auto_tables(sections),
    )


def _col(name: str) -> bool:
    """Keep real column tokens; drop decoration like dots and dashes."""
    return bool(re.fullmatch(r"[A-Z][A-Z0-9]*", name))


def _auto_tables(sections: dict) -> dict:
    """AUTOMATIC MANAGEMENT holds several sub-tables under one @-header per table;
    they arrive as separate (header, rows) blocks. Return them keyed by their
    first column token (PLANTING/IRRIGATION/NITROGEN/RESIDUES/HARVEST)."""
    out: dict[str, dict] = {}
    blocks = sections.get("AUTOMATIC MANAGEMENT", [])
    for hdr, rows in blocks:
        if not hdr or not rows:
            continue
        out[hdr[0]] = {c: (rows[0][i] if i < len(rows[0]) else "-99")
                       for i, c in enumerate(hdr) if _col(c)}
    return out


# -- emission ---------------------------------------------------------------------------------


def emit_filex(dest: Path, *, experiment_id: str, title: str, seasons: list[dict],
               controls: dict, potential: bool, soil_id: str, wsta: str,
               auto: dict | None = None) -> None:
    """Write one .RIX for ONE run into its isolated work directory.

    seasons: list of dicts with keys cultivar, cultivar_name, planting (date),
    establishment, ppop, ppoe, plrs, pldp, irrigation, fertilizer, ic (ICData|None),
    termination — the second season makes it a sequence experiment (two treatments,
    run back-to-back with soil carry-over by the runner).

    potential=True forces WATER=N NITRO=N in the OPTIONS row (spec §4 ideal run),
    whatever the preset's controls say.
    """
    p1 = seasons[0]
    id_lines = [f"*EXP.DETAILS: {experiment_id}RI {title}"]
    if potential:
        id_lines.append("! IDEAL (POTENTIAL) RUN: WATER AND NITROGEN STRESS SWITCHED OFF")
    if len(seasons) > 1:
        id_lines.append("! SEQUENCE EXPERIMENT: TREATMENTS RUN IN ORDER, SOIL STATE CARRIES OVER")
    lines: list[str] = id_lines + [
        "",
        "*GENERAL",
        "@PEOPLE",
        "ORYZON recommendation service",
        "@ADDRESS",
        "-99",
        "@SITE",
        "-99",
        "",
        "*TREATMENTS                        -------------FACTOR LEVELS------------",
        "@N R O C TNAME.................... CU FL SA IC MP MI MF MR MC MT ME MH SM",
    ]
    for i, s in enumerate(seasons, 1):
        tname = f"Season {i}" if len(seasons) > 1 else (s.get("tname") or title or "ORYZON")
        # CU FL SA IC MP MI MF MR MC MT ME MH SM — management factors on record (R)
        lines.append(f" {i} 1 1 0 {tname:<23} 1  1  0  {i}  1  1  1  0  0  0  0  0  1")
    lines += [
        "",
        "*CULTIVARS",
        "@C CR INGENO CNAME",
    ]
    for i, s in enumerate(seasons, 1):
        lines.append(f" {i} RI {s['cultivar']} {s.get('cultivar_name') or '-99'}")
    lines += [
        "",
        "*FIELDS",
        "@L ID_FIELD WSTA....  FLSA  FLOB  FLDT  FLDD  FLDS  FLST SLTX  SLDP  ID_SOIL    FLNAME",
        f" 1 ORYZON   {wsta}       -99   -99 DR000   -99   -99     0 -99   -99  {soil_id} -99",
        "@L ...........XCRD ...........YCRD .....ELEV .............AREA .SLEN .FLWR .SLAS FLHST FHDUR",
        " 1             -99             -99       -99               -99   -99   -99   -99   -99   -99",
        "",
    ]

    # INITIAL CONDITIONS — first season only (spec D1: IC feeds the first season)
    ic = p1.get("ic")
    lines += ["*INITIAL CONDITIONS",
              "@C   PCR ICDAT  ICRT  ICND  ICRN  ICRE  ICWD ICRES ICREN ICREP ICRIP ICRID ICNAME"]
    pdate = p1["planting"]
    if ic is None:
        lines.append(f" 1    R {_date_to_yyddd(pdate)}   -99   -99     1     1   -99   -99   -99   -99   -99   -99 -99")
        lines += ["@C  ICBL  SH2O  SNH4  SNO3"]
    else:
        lines.append(f" 1    R {_date_to_yyddd(pdate)}  {ic.root_kg_ha:>5.0f}   -99     1     1   -99   -99   -99   -99   -99   -99 -99")
        lines += ["@C  ICBL  SH2O  SNH4  SNO3"]
        for layer in ic.layers:
            lines.append(f" 1 {layer['slb']:>5.0f} {layer['sh2o']:.3f} {layer['snh4']:>5.1f} {layer['sno3']:>5.1f}")
    lines.append("")

    # one PLANTING/IRRIGATION/FERTILIZER block per season, as separate treatments
    for i, s in enumerate(seasons, 1):
        pd = s["planting"]
        est = s.get("establishment", "DS")
        plme = "T" if est == "T" else "S"
        ppop = s.get("ppop", -99)
        ppoe = s.get("ppoe", -99)
        lines += ["*PLANTING DETAILS" if i == 1 else "",
                  "@P PDATE EDATE  PPOP  PPOE  PLME  PLDS  PLRS  PLRD  PLDP  PLWT  PAGE  PENV  PLPH  SPRL                        PLNAME",
                  f" {i} {_date_to_yyddd(pd)}   -99  {ppop:>5} {ppoe:>5}  {plme:>5}     U     0     0  {s.get('pldp', 2):>5}   -99     0     0     0   -99                        -99"]
        irr = s.get("irrigation") or ()
        if irr:
            lines += ["*IRRIGATION AND WATER MANAGEMENT",
                      "@I  EFIR  IDEP  ITHR  IEPT  IOFF  IAME  IAMT IRNAME",
                      " 1     1    30    50   100 GS000 IR001    10 -99",
                      "@I IDATE  IROP IRVAL"]
            for e in irr:
                lines.append(f" {i} {_date_to_yyddd(e['date'])} IR009 {e['amount_mm']:>5.0f}")
        fert = s.get("fertilizer") or ()
        if fert:
            lines += ["*FERTILIZERS (INORGANIC)",
                      "@F FDATE  FMCD  FACD  FDEP  FAMN  FAMP  FAMK  FAMC  FAMO  FOCD FERNAME"]
            for e in fert:
                lines.append(f" {i} {_date_to_yyddd(e['date'])} FE005 {e.get('placement', 'AP002'):>5}   {e.get('depth_cm', 5):>3} {e['kg_n_ha']:>5.0f}   -99   -99   -99   -99   -99 -99")
    lines.append("")

    # SIMULATION CONTROLS — app-authored; potential flips WATER/NITRO off
    options = controls.get("OPTIONS", {})
    lines += ["*SIMULATION CONTROLS",
              "@N GENERAL     NYERS NREPS START SDATE RSEED SNAME.................... SMODEL",
              f" 1 GE              1     1     S {_date_to_yyddd(pdate)}  2150 {'ORYZON ' + title[:18]:<24}  RICER",
              "@N OPTIONS     WATER NITRO SYMBI PHOSP POTAS DISES  CHEM  TILL   CO2",
              f" 1 OP              {'N' if potential else 'Y'}     {'N' if potential else 'Y'}     N     N     N     N     N     N     M",
              "@N METHODS     WTHER INCON LIGHT EVAPO INFIL PHOTO HYDRO NSWIT MESOM MESEV MESOL",
              f" 1 ME              M     M     E     R     S     L     R     1     {options.get('MESOM', 'G'):>5}     R     {options.get('MESOL', 2):>2}",
              "@N MANAGEMENT  PLANT IRRIG FERTI RESID HARVS",
              f" 1 MA              R     {'A' if not potential and p1.get('irrigation_auto', False) else 'R'}     R     R     M",
              "@N OUTPUTS     FNAME OVVEW SUMRY FROPT GROUT CAOUT WAOUT NIOUT MIOUT DIOUT VBOSE CHOUT OPOUT FMOPT",
              " 1 OU              N     Y     Y     1     Y     Y     Y     Y     Y     N     Y     N     Y     A"]
    if auto:
        am = auto.get("IRRIGATION", {})
        lines += ["",
                  "@  AUTOMATIC MANAGEMENT",
                  "@N IRRIGATION  IMDEP ITHRL ITHRU IROFF IMETH IRAMT IREFF",
                  f" 1 IR            {am.get('IMDEP', 30):>3} {am.get('ITHRL', 50):>5} {am.get('ITHRU', 100):>5} {am.get('IROFF', 'GS000'):>5} {am.get('IMETH', 'IR001'):>5} {am.get('IRAMT', 10):>5}     1"]
    dest.write_text("\n".join(lines) + "\n")
