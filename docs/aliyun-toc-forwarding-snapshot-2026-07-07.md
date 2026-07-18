# Aliyun TOC Forwarding Snapshot (2026-07-07)

Snapshot time: `2026-07-07T13:47:52+08:00`

Purpose: preserve the current public TOC forwarding state before rebooting the
Aliyun server, so the public edge can be checked or reconnected afterward.

## Current Public Chain

```text
Public client
  -> http://123.56.135.150:80/
  -> Aliyun Nginx
  -> Tailscale
  -> 4A100 / wnds-server 100.116.34.3:3081
  -> Docker host port 3081
  -> lobehub-toc-lb / HAProxy container port 80
  -> lobe:3210
  -> lobehub-toc-lobe
```

The working public TOC entry is currently the bare IP:

- `http://123.56.135.150/`

The sslip host is not currently serving TOC:

- `http://toc.123.56.135.150.sslip.io/` returned Aliyun ICP block `403`

## 4A100 Production State

Project directory:

```bash
cd /home/duxianghe/ModelNet-toc
```

Production compose state at snapshot time:

```text
lobehub-toc-lb       Up 10 days             0.0.0.0:3081->80/tcp, [::]:3081->80/tcp
lobehub-toc-lobe     Up 10 days (healthy)   3210/tcp
modelnet-litellm     Up 2 weeks             4000/tcp, 127.0.0.1:3090->8000/tcp
modelnet-router      Up 6 days (healthy)    127.0.0.1:3092->8000/tcp
```

Important local config:

- `.env`: `LOBE_PORT=3081`
- `.env`: `APP_URL=http://123.56.135.150`
- `.env`: `INTERNAL_APP_URL=http://localhost:3210`
- `docker-compose.yml`: `toc-lb` publishes `${LOBE_PORT}:80`
- `haproxy.cfg`: frontend `toc_http` binds `*:80` and forwards to `lobe:3210`

4A100 IPs included the current Tailscale address:

```text
100.116.34.3
```

## Verified Endpoints

These checks passed before the Aliyun reboot:

```bash
curl -sS -L -o /tmp/toc-snapshot-local.html \
  -w "%{http_code} %{url_effective}\n" \
  http://127.0.0.1:3081/signin
# 200 http://127.0.0.1:3081/signin
```

```bash
curl -sS -L -H "Host: 123.56.135.150" -o /tmp/toc-snapshot-ts-host.html \
  -w "%{http_code} %{url_effective}\n" \
  http://100.116.34.3:3081/signin
# 200 http://100.116.34.3:3081/signin
```

```bash
curl -sS -L -o /tmp/toc-snapshot-public.html \
  -w "%{http_code} %{url_effective}\n" \
  http://123.56.135.150/
# 200 http://123.56.135.150/signin?callbackUrl=http%3A%2F%2F123.56.135.150%2F
```

Expected private ModelNet ports remained closed from the public IP:

```bash
curl -sS -m 5 -o /tmp/toc-snapshot-public-3090.txt \
  -w "%{http_code} %{errormsg}\n" \
  http://123.56.135.150:3090/
# 000 Operation timed out after 5002 milliseconds with 0 bytes received
```

```bash
curl -sS -m 5 -o /tmp/toc-snapshot-public-3092.txt \
  -w "%{http_code} %{errormsg}\n" \
  http://123.56.135.150:3092/healthz
# 000 Operation timed out after 5002 milliseconds with 0 bytes received
```

## Expected Aliyun Edge

This section is from project memory, not live-read during this snapshot because
the `aliyunM` SSH alias was not resolvable in this Codex shell.

Aliyun public IP:

```text
123.56.135.150
```

Expected Aliyun Nginx config path:

```text
/etc/nginx/conf.d/toc-dify-tailscale.conf
```

Expected Aliyun routing:

- `http://123.56.135.150/` proxies to `100.116.34.3:3081` for TOC.
- `http://123.56.135.150:8080/` proxies to `100.116.34.3:80` for Dify / TOB.
- Aliyun should not expose ModelNet gateway ports `3090` or `3092`.

Known Tailscale identities from project memory:

- Aliyun Tailscale IP: `100.76.239.10`
- 4A100 / `wnds-server` Tailscale IP: `100.116.34.3`

## Post-Reboot Recovery Checklist

On Aliyun, verify Nginx and Tailscale:

```bash
ssh aliyunM "systemctl is-active nginx"
ssh aliyunM "nginx -t"
ssh aliyunM "tailscale status"
```

If `aliyunM` alias is unavailable, reconnect with the configured SSH host/IP
for `123.56.135.150`, then check:

```bash
sudo systemctl restart tailscaled
sudo systemctl restart nginx
sudo nginx -t
sudo systemctl status nginx --no-pager
tailscale status
```

Verify from 4A100:

```bash
cd /home/duxianghe/ModelNet-toc
docker compose ps
curl -sS -L -o /tmp/toc-local.html -w "%{http_code}\n" http://127.0.0.1:3081/signin
curl -sS -L -H "Host: 123.56.135.150" -o /tmp/toc-ts.html -w "%{http_code}\n" http://100.116.34.3:3081/signin
curl -sS -L -o /tmp/toc-public.html -w "%{http_code} %{url_effective}\n" http://123.56.135.150/
```

Verify from Aliyun itself after reboot:

```bash
curl -sS -L -o /tmp/toc.html -w "%{http_code} %{url_effective}\n" http://127.0.0.1/
curl -sS -L -o /tmp/tob.html -w "%{http_code} %{url_effective}\n" http://127.0.0.1:8080/
curl -sS -L -H "Host: 123.56.135.150" -o /tmp/toc-4a100.html -w "%{http_code}\n" http://100.116.34.3:3081/signin
```

Do not "fix" public TOC by exposing LiteLLM or Router directly. The intended
shape is TOC through Aliyun/Nginx/HAProxy, with LiteLLM and Router reachable
only internally or on localhost debug ports.
