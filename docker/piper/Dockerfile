# Piper text to speech (github.com/OHF-Voice/piper1-gpl) for device speech
# (lib/devices/tts.ts). Piper is GPL-3.0, so it runs as its own service and
# stays out of the agent image; the agent reaches it at PIPER_URL.
FROM python:3.12-slim

ARG PIPER_VERSION=1.8.0
RUN pip install --no-cache-dir "piper-tts[http]==${PIPER_VERSION}"

# One voice per language (lib/devices/tts.ts PIPER_DEFAULT_VOICES); add more
# with --build-arg VOICES="…" and map them in the device's speech settings.
ARG VOICES="en_US-lessac-medium it_IT-paola-medium"
RUN mkdir /voices && python3 -m piper.download_voices --data-dir /voices ${VOICES}

RUN useradd --system --no-create-home piper
USER piper
EXPOSE 5000
CMD ["python3", "-m", "piper.http_server", "--host", "0.0.0.0", "--port", "5000", "--data-dir", "/voices", "-m", "en_US-lessac-medium"]
