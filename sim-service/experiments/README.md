# DSSAT experiment files

Drop original DSSAT FileX experiment files into this directory. DSSAT's FileX
extensions use a three-character crop/model code followed by `X`, for example:

- `.RIX` — rice
- `.MZX` — maize
- `.SBX` — soybean
- `.TMX` — tomato

The service discovers these files without converting or rewriting them. The raw
execution API is separate from the rice recommendation flow:

- `GET /api/filex` lists the discovered FileX files.
- `POST /api/filex/{filename}/run` stages and runs one file with
  `dscsm048 A {filename}`.

## Supporting files

A FileX is not self-contained. Its `FIELDS` section identifies a weather station
(`WSTA`) and soil profile (`ID_SOIL`). DSSAT also needs the matching crop genotype
files and model data.

1. Put the FileX file here.
2. Put its required station weather files (`WSTA*.WTH`) here too, unless they are
   already under `DSSAT_HOME/Weather`.
3. Put a matching soil file (for example `PH.SOL`) here if the profile is not in
   the soil file configured for ORYZON.
4. Ensure `DSSAT_HOME/Genotype` contains the relevant crop's `.CUL`, `.SPE`, and
   `.ECO` files, and that `DSSATPRO.L48` points to that DSSAT installation.

The runner copies the FileX unchanged, stages the matching weather/soil data and
DSSAT path profile into an isolated run directory under `dssat/filex-runs/`, then
runs DSSAT there. It retains output files and logs for inspection.

## Recommendation presets versus raw FileX

The existing `.RIX` files are also available as rice management presets through
`GET /api/experiments`. In that workflow the service extracts management and
generates a farm-specific FileX for each actual/ideal simulation. Non-rice FileX
files are not treated as rice presets; they are run through the raw FileX endpoint.

## Cultivar selection in rice recommendations

The recommendation UI reads IDs and display names from the installed
`Genotype/RICER048.CUL`. Select between 1 and 10 entries. The service validates
the IDs against that same file before queuing a recommendation. The stock CUL file
is not rewritten or pruned, so DSSAT's original cultivar coefficients remain intact.
