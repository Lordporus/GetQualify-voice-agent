# Rumik TTS overlay, stacked on top of the existing VoiceLink overlay so both
# providers stay available.
#
# --no-deps is REQUIRED: Dograh vendors its own pipecat fork (tagged v1.1.0)
# but setuptools_scm cannot read the submodule tags, so the installed
# pipecat-ai reports 0.0.0.dev0. pipecat-rumik declares pipecat-ai>=1.0.0,<2,
# so a normal install would either fail resolution or pull upstream pipecat
# from PyPI straight over Dograh's fork and break the box.
# Its other three deps (aiohttp, certifi, websockets) are already in the image.
FROM ghcr.io/dograh-hq/dograh-api:latest

# The base image runs as `dograh`, but /opt/venv is root-owned.
USER root
RUN pip install --no-cache-dir --no-deps pipecat-rumik==0.1.4

COPY --chown=dograh:dograh registry.py        /app/api/services/configuration/registry.py
COPY --chown=dograh:dograh check_validity.py  /app/api/services/configuration/check_validity.py
COPY --chown=dograh:dograh service_factory.py /app/api/services/pipecat/service_factory.py

# Restore the base image's runtime user.
USER dograh
