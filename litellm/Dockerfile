ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:main-latest
FROM ${LITELLM_BASE_IMAGE}

COPY patches/modelnet_responses_passthrough.py /tmp/modelnet_responses_passthrough.py
RUN python /tmp/modelnet_responses_passthrough.py
