# Deploying the DSSAT service to Render

The recommendation service must run as a Docker web service. The repository's
previous checked-in `dscsm048` executable was built against a GLIBC version newer
than Render's native Python runtime. This deployment builds DSSAT-CSM from source
inside the image, then runs it on the same Debian base image. The resulting binary
and Python process therefore share a compatible libc runtime.

## Render service settings

For the existing recommendation API web service:

1. Change the service runtime/environment to **Docker**.
2. Set the Dockerfile path to `./Dockerfile`.
3. Set the Docker build context to the repository root (`.`).
4. Leave the root directory empty.
5. Leave the start command empty so the Dockerfile's startup command is used.
6. Deploy the branch containing this change.

The container listens on Render's injected `PORT` (defaulting to 8000 locally).

## Environment variables

Keep the existing Hugging Face configuration used to download the soil file:

- `ORYZON_HF_REPO`
- `ORYZON_SOIL_HF_PATH`
- `HF_TOKEN`, if the dataset is private

The image sets these automatically:

- `ORYZON_RUNNER=dssat`
- `ORYZON_DSSAT_HOME=/opt/dssat`
- `ORYZON_DSSAT_DIR=/tmp/oryzon/dssat-work`

Remove any old `ORYZON_DSSAT_HOME` override in Render. It would override the
container's compiled installation path.

## What happens during the image build

- Clone DSSAT-CSM-OS from its `develop` branch (override Docker build argument
  `DSSAT_REF` to build another branch or tag).
- Compile the Fortran model with CMake and GNU Fortran in the image's Debian
  environment.
- Install the DSSAT data files and executable under `/opt/dssat`.
- Install the Python service dependencies.
- At container startup, run `sim-service/dssat_setup.py`. It checks the executable,
  rice cultivar file, DSSAT profile, and shared-library dependencies before starting
  Uvicorn.

The build currently targets DSSAT 4.8.6. It requires network access to GitHub during
the Docker build. The first build will take longer because it compiles DSSAT; later
deploys can use Render's Docker layer cache.

## Local build

From the repository root:

```bash
docker build -t oryzon-sim .
docker run --rm -p 8000:8000 \
  -e ORYZON_HF_REPO="JyanMan/OryzonDataset" \
  oryzon-sim
```

Then check `http://localhost:8000/health`.
