# Build DSSAT inside the same Debian release used by the Python runtime.
# This avoids shipping a binary linked against a newer GLIBC than Render provides.
FROM python:3.12-slim-bookworm AS dssat-build

ARG DSSAT_REF=develop

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates cmake gfortran git make \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${DSSAT_REF}" \
      https://github.com/DSSAT/dssat-csm-os.git /src/dssat-csm-os \
    && cmake -S /src/dssat-csm-os -B /build/dssat \
       -DCMAKE_BUILD_TYPE=RELEASE \
       -DCMAKE_INSTALL_PREFIX=/opt/dssat \
    && cmake --build /build/dssat --parallel 2 \
    && cmake --install /build/dssat \
    && test -x /opt/dssat/dscsm048 \
    && test -s /opt/dssat/DSSATPRO.L48 \
    && test -s /opt/dssat/Genotype/RICER048.CUL \
    && printf '4.8.6\\n' > /opt/dssat/DSSAT_VERSION \
    && printf '%s\\n' "${DSSAT_REF}" > /opt/dssat/DSSAT_BUILD_REF

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ORYZON_RUNNER=dssat \
    ORYZON_DSSAT_HOME=/opt/dssat \
    ORYZON_DSSAT_DIR=/tmp/oryzon/dssat-work

# binutils provides readelf, which the startup validator uses to distinguish
# dynamically linked DSSAT builds from valid static executables.
RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils libgfortran5 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=dssat-build /opt/dssat /opt/dssat
COPY sim-service/requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r /app/requirements.txt

COPY sim-service/ /app/sim-service/

WORKDIR /app/sim-service

EXPOSE 8000

# Validate the compiled model and its runtime libraries before accepting traffic.
CMD ["sh", "-c", "python dssat_setup.py && exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
