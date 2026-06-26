# ModelNet Registry Source Producer

`scripts/modelnet_registry_source.py` is the standalone Kubernetes discovery
producer for the ModelNet capability registry. It replaces the old Dify-owned
K8s discovery path for producing:

`/home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml`

The producer does not import Dify modules and does not write Dify provider
tables. It discovers OpenAI-compatible backends and writes a self-contained
`capability-registry.yaml` with capability groups plus embedded model inventory.

## Inputs

- Kubernetes API access via `--kubeconfig` or in-cluster service account.
- Namespaces, usually `inference,llama-cpp`.
- Optional NodePort host for `llama-cpp` style services.
- Writable output path for the source registry.

## Dry Run

```bash
python3 scripts/modelnet_registry_source.py \
  --dry-run \
  --output /tmp/modelnet-capability-registry-dry-run.yaml \
  --status-output /tmp/modelnet-registry-source-dry-run-status.json \
  --kubeconfig /home/duxianghe/.kube/config \
  --namespaces inference,llama-cpp \
  --nodeport-host 219.222.20.79 \
  --triggered-by manual-dry-run
```

## Write Source

```bash
python3 scripts/modelnet_registry_source.py \
  --output /home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml \
  --status-output /home/duxianghe/modelnet-runtime/registry-source/status.json \
  --kubeconfig /home/duxianghe/.kube/config \
  --namespaces inference,llama-cpp \
  --nodeport-host 219.222.20.79 \
  --triggered-by registry-source-producer
```

## Run Periodically

```bash
python3 scripts/modelnet_registry_source.py \
  --output /home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml \
  --status-output /home/duxianghe/modelnet-runtime/registry-source/status.json \
  --kubeconfig /home/duxianghe/.kube/config \
  --namespaces inference,llama-cpp \
  --nodeport-host 219.222.20.79 \
  --interval-seconds 60 \
  --triggered-by registry-source-producer
```

## Publish Bundle

After the source changes, publish a versioned bundle:

```bash
python3 scripts/publish_modelnet_registry.py \
  --source /home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml \
  --root /home/duxianghe/modelnet-runtime/registry-dev
```

The publisher consumes `capability-registry.yaml` as the single registry
source. The published dev bundle keeps that YAML plus generated LiteLLM config,
version metadata, and checksums; it no longer includes `model_net.yaml`.

## Safety

- Probe failures are skipped and do not enter `capability-registry.yaml`.
- If discovery returns a smaller partial registry while routes failed probes,
  the existing output file is preserved by default.
- `--dry-run` writes only the status file and never replaces the source registry.
- Dify provider/database synchronization is intentionally out of scope.
