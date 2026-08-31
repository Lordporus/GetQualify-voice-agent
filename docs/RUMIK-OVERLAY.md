# Adding Rumik silk as a Dograh TTS provider

Rumik is not a stock Dograh provider. It is added as a Docker overlay on top of
the running API image.

## The `--no-deps` trap

```dockerfile
RUN pip install --no-cache-dir --no-deps pipecat-rumik==0.1.4
```

`--no-deps` is REQUIRED, and omitting it breaks the box.

Dograh vendors its own pipecat fork, tagged v1.1.0, as a submodule. setuptools_scm
cannot read tags through the submodule, so the installed `pipecat-ai` self-reports
its version as `0.0.0.dev0`. `pipecat-rumik` declares `pipecat-ai>=1.0.0,<2`.

A normal `pip install` therefore does one of two things, both bad: it fails
resolution outright, or it satisfies the constraint by pulling upstream pipecat
from PyPI straight over Dograh's fork, which replaces the vendored runtime and
breaks the API container in ways that are hard to trace back to this step.

The plugin's other three dependencies (aiohttp, certifi, websockets) are already
present in the base image, so `--no-deps` costs nothing.

## Files that need patching

Two files are copied out of the running image, patched, and copied back in:

| File | Change |
|---|---|
| `/app/api/services/configuration/registry.py` | Register a `rumik` entry in the TTS provider registry: id, label, models (`mulberry`, `muga`), voices, and the tunable fields (temperature, top_p, top_k, description, full_response_aggregation) |
| `/app/api/services/pipecat/service_factory.py` | Construct a `RumikTTSService` from `pipecat_rumik` when `provider == "rumik"`, passing api_key, model, voice, description and the sampling params through |

The repository includes the verified patched files in `rumik-overlay-local/`
for the pinned reference deployment, with Dograh's BSD 2-Clause license. When
upgrading Dograh, extract the same files from the new image, reapply the Rumik
changes, and review the diff. Reusing a stale copy can silently revert unrelated
upstream behaviour.

## Stacking overlays

Overlays chain by `FROM`. On the reference deployment:

```
dograhai/dograh-api:v1.42.0
  -> local/dograh-api:voicelink-v1        (VoiceLink telephony plugin)
    -> local/dograh-api:voicelink-rumik-v1 (this overlay)
```

`deploy/02-build-rumik-overlay.sh` reads the currently running image and rewrites
the `FROM` line, so it stacks correctly whether or not other overlays exist.

Pin the result in `docker-compose.override.yaml` with `pull_policy: never`, or a
later `docker compose pull` will replace your image with the upstream one and
Rumik will vanish:

```yaml
services:
  api:
    image: local/dograh-api:rumik-v1
    pull_policy: never
```

## Voice settings in use

```json
{
  "provider": "rumik",
  "model": "mulberry",
  "voice": "ira",
  "description": "a warm 30s indian english voice, smooth timbre, natural conversational pacing, like a friendly receptionist",
  "temperature": 0.6,
  "top_p": 0.95,
  "top_k": 50,
  "full_response_aggregation": true
}
```

`mulberry` is the fast model and the right default for phone. `muga` is more
expressive and costs roughly twice as much. `description` is a free-text voice
prompt, it is worth tuning by ear before shipping.
