"""ORYZON recommendation service configuration.

Every value below traces to the spec (AGENT-README.md) or to a decision recorded in
AUDIT.md section 1 (project owner, 2026-11-15). Change values here, never in code.

No local data store: weather is requested from the NASA POWER API (see store.py) and the soil
profile file is downloaded once from Hugging Face.
"""
import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
REPO_DIR = SERVICE_DIR.parent

# DSSAT workspace: one subdir per run (spec §5 "isolated working directory"),
# laid out as intermediate-input-files/<run>/, intermediate-output-files/<run>/,
# output-files-for-frontend/<run>.json. The runner writes; this service reads back.
DSSAT_DIR = Path(os.environ.get("ORYZON_DSSAT_DIR", str(REPO_DIR / "dssat")))

# --- Soil profiles (DSSAT PH.SOL) ----------------------------------------------------------
# Downloaded once from a Hugging Face dataset repo and cached by huggingface_hub.
#   ORYZON_HF_REPO       the dataset repo id, e.g. "JyanMan/OryzonDataset"
#   ORYZON_SOIL_HF_PATH  where PH.SOL sits inside that repo
#   HF_TOKEN             only needed if the repo is private
#   ORYZON_SOIL_FILE     optional: use this local file instead of downloading
HF_REPO = os.environ.get("ORYZON_HF_REPO", "JyanMan/OryzonDataset")
SOIL_HF_PATH = os.environ.get(
    "ORYZON_SOIL_HF_PATH",
    "oryzon_data/processed/dssat-SOL-files/SoilGrids-for-DSSAT-10km v1.0 (by country)/PH.SOL",
)


def _soil_file() -> Path:
    override = os.environ.get("ORYZON_SOIL_FILE")
    if override:
        return Path(override).expanduser().resolve()
    from huggingface_hub import hf_hub_download
    try:
        return Path(hf_hub_download(
            repo_id=HF_REPO, filename=SOIL_HF_PATH, repo_type="dataset",
            token=os.environ.get("HF_TOKEN")))
    except Exception as exc:
        raise RuntimeError(
            f"could not download {SOIL_HF_PATH} from the Hugging Face repo {HF_REPO}: "
            f"{type(exc).__name__}: {exc}. Upload PH.SOL there (or set ORYZON_SOIL_HF_PATH), "
            f"set HF_TOKEN if the repo is private, or set ORYZON_SOIL_FILE to a local copy.")


SOIL_FILE = _soil_file()

# --- Ranking config (spec §4) ------------------------------------------------------------

# One source for the whole deployment. "table" fails at startup unless the table covers
# every candidate crop AND rice (spec §4; validated in main.py).
IDEAL_YIELD_SOURCE = "simulated_potential"
IDEAL_TABLE_PATH = SERVICE_DIR / "ideal_table.csv"   # only read when the source above is "table"

WEATHER_YEARS: list[int] | None = None
# None = the 10 most recent complete years (spec §4 default).
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

WEATHER_SOURCE = ("NASA POWER daily API (T2M/T2M_MAX/T2M_MIN/RH2M/ALLSKY_SFC_SW_DWN/PRECTOTCORR); "
                  "rainfall is POWER PRECTOTCORR, not GPM IMERG")
SOIL_OM_MODULE = "Godwin (DSSAT MESOM=G)"   # chosen and documented per spec §8; re-confirm at calibration

# --- Runner selection ----------------------------------------------------------------------

# "stub" until the owner's DSSAT runner lands (AUDIT.md §5); build_runner fails on anything else.
RUNNER = os.environ.get("ORYZON_RUNNER", "stub")
