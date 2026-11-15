"""ORYZON recommendation service configuration.

Every value below traces to the spec (AGENT-README.md) or to a decision recorded in
AUDIT.md section 1 (project owner, 2026-11-15). Change values here, never in code.
"""
import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
REPO_DIR = SERVICE_DIR.parent

# DSSAT workspace: one subdir per run (spec §5 "isolated working directory"),
# laid out as intermediate-input-files/<run>/, intermediate-output-files/<run>/,
# output-files-for-frontend/<run>.json. The runner writes; this service reads back.
DSSAT_DIR = REPO_DIR / "dssat"


# Owner's processed data store (POWER daily, IMERG daily, soil profiles). The data lives
# outside the repo (AUDIT.md D6) and this service never assumes a machine layout: the
# location is a deployment seam set via environment variable, validated at startup.
def _env_path(name: str, what: str) -> Path:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Point it at {what}; the data lives outside this repo, "
            f"so no default path is assumed. Example: export {name}=/path/to/oryzon_data")
    return Path(value).expanduser().resolve()

DATA_ROOT = _env_path("ORYZON_DATA_ROOT", "the processed oryzon_data store")
SOIL_FILE = Path(os.environ.get(
    "ORYZON_SOIL_FILE",
    str(DATA_ROOT.parent / "soil-profiles" / "dssat-SOL-files"
        / "SoilGrids-for-DSSAT-10km v1.0 (by country)" / "PH.SOL")))

# --- Ranking config (spec §4) ------------------------------------------------------------

# One source for the whole deployment. "table" fails at startup unless the table covers
# every candidate crop AND rice (spec §4; validated in main.py).
IDEAL_YIELD_SOURCE = "simulated_potential"
IDEAL_TABLE_PATH = SERVICE_DIR / "ideal_table.csv"   # only read when the source above is "table"

WEATHER_YEARS: list[int] | None = None
# None = the 10 most recent complete years available in the store (spec §4 default).
# A single year gives deterministic behaviour: P10/P90 are then not reported.

# --- Initial conditions (spec §2: built here from the farm record + defaults) --------------
# Values inherited from the verified example run; owner-tunable (AUDIT.md A2).
IC_ROOT_KG_HA = 200.0      # icrt: initial root biomass
IC_PCR = "RI"              # pcr: previous crop = rice paddy
IC_NH4_TOP = 15.0          # mg/kg mineral NH4, top 3 layers
IC_NO3_TOP = 8.0
IC_NH4_DEEP = 1.0
IC_NO3_DEEP = 0.5
SOIL_DEPTH_CM = 20   # depth for the soil net-change metrics (spec §4)


# --- Sequence rules (AUDIT.md O1/O2/O5) ----------------------------------------------------

STAGE2_GAP_DAYS = 7    # rice planted this many days after the pre-crop's simulated maturity
COVER_TERM_DAP = 45    # mung bean cover terminated this many days after its planting
COVER_RESIDUE = "incorporate"   # all aboveground residue at termination (spec default)

# --- Metadata (rule 6); runner supplies DSSAT version + cultivar source at runtime ----------

WEATHER_SOURCE = "NASA POWER daily (T2M/T2M_MAX/T2M_MIN/RH2M/SRAD) + GPM IMERG daily rain"
SOIL_OM_MODULE = "Godwin (DSSAT MESOM=G)"   # chosen and documented per spec §8; re-confirm at calibration

# --- Runner selection ----------------------------------------------------------------------

# "stub" until the owner's DSSAT runner lands (AUDIT.md §5); build_runner fails on anything else.
RUNNER = os.environ.get("ORYZON_RUNNER", "stub")
