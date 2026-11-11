# docproc image. Core build (default): Office + text-layer PDF, ~200 MB.
#   docker build -t medexregai/docproc services/docproc
# Full build adds Docling layout + OCR and bakes its models in (several GB):
#   docker build --build-arg FULL=1 -t medexregai/docproc:full services/docproc
# The no-egress network, CPU/memory/process limits, read-only root and dropped
# capabilities are set where the container runs: docker-compose.yml (local) and
# infra/terraform/modules/platform/docproc.tf + compute.tf (AWS).
FROM python:3.12.8-slim
ARG FULL=0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DOCPROC_HOST=0.0.0.0 DOCPROC_PORT=4200
WORKDIR /app
COPY requirements.txt requirements-docling.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$FULL" = "1" ]; then \
      pip install --no-cache-dir -r requirements-docling.txt \
      && docling-tools models download -o /opt/docling-models; \
    fi
# Only read when Docling is installed; the sandbox cannot download models at run time.
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models HF_HUB_OFFLINE=1
COPY docproc ./docproc
RUN useradd --system --uid 10001 docproc
USER 10001
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:4200/health',timeout=2)"
CMD ["python", "-m", "docproc"]
