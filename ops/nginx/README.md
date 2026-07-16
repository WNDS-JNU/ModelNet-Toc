# ModelNet Device Gateway ingress

The public entry is `https://123.56.135.150`. Aliyun Nginx reaches both
Gateway instances through restricted SSH reverse tunnels; neither Gateway binds
a LAN or public interface.

| Public route | Aliyun loopback | 4A100 target |
| --- | --- | --- |
| `/ws`, `/healthz` | `127.0.0.1:13093` | `127.0.0.1:3093` |
| `/dev/ws`, `/dev/healthz` | `127.0.0.1:13193` | `127.0.0.1:3193` |
| Dify HTTP | `127.0.0.1:13080` | `127.0.0.1:80` |

The existing TOC tunnel on `127.0.0.1:13081` is intentionally not managed by
the Gateway tunnel service.

## Restricted SSH tunnel

On Aliyun, replace the existing `modelnet-tunnel` key line with
`../ssh/modelnet-tunnel.authorized_keys.example` after inserting the real
public key. Keep `GatewayPorts no` in `sshd_config`, then validate and reload
SSH. Keep the `modelnet-tunnel` account on a non-login shell. The `restrict`
key option disables PTY/agent/X11 forwarding, while `permitlisten` restricts
remote listeners to the four project loopback ports.

On 4A100, install and start the user service:

```bash
install -d -m 0700 ~/.config/systemd/user
install -m 0644 ../systemd/modelnet-gateway-ssh-tunnel.service \
  ~/.config/systemd/user/modelnet-gateway-ssh-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now modelnet-gateway-ssh-tunnel.service
sudo loginctl enable-linger "$(id -un)"
```

Confirm on Aliyun that `13080`, `13081`, `13093`, and `13193` listen only
on `127.0.0.1`. Dify may remain stopped; its forward can be reserved safely.

## Public IP certificate

The renewal script uses the Let's Encrypt short-lived certificate profile and
TLS-ALPN-01. It checks twice daily but releases port 443 only when the
certificate has three days or less remaining. Before renewal it backs up the
current certificate; any ACME or Nginx validation failure restores the backup
and restarts Nginx when it was previously active.

Install lego v5 at `/usr/local/bin/lego-v5`, then install the script, root-only
environment file, and timer:

```bash
sudo install -m 0755 ../scripts/renew-modelnet-gateway-ip-certificate.sh \
  /usr/local/sbin/renew-modelnet-gateway-ip-certificate
sudo install -d -m 0750 /etc/modelnet
sudo install -m 0600 ../systemd/modelnet-gateway-ip-cert.env.example \
  /etc/modelnet/modelnet-gateway-ip-cert.env
sudoedit /etc/modelnet/modelnet-gateway-ip-cert.env
sudo install -m 0644 ../systemd/modelnet-gateway-ip-cert-renew.service \
  /etc/systemd/system/modelnet-gateway-ip-cert-renew.service
sudo install -m 0644 ../systemd/modelnet-gateway-ip-cert-renew.timer \
  /etc/systemd/system/modelnet-gateway-ip-cert-renew.timer
sudo systemctl daemon-reload
sudo systemctl start modelnet-gateway-ip-cert-renew.service
```

After the first production certificate exists, install
`modelnet-device-gateway-ip.conf` without modifying the existing TOC/Dify
files. Always validate before reload, then enable the timer:

```bash
sudo install -m 0644 modelnet-device-gateway-ip.conf \
  /etc/nginx/conf.d/modelnet-device-gateway-ip.conf
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable --now modelnet-gateway-ip-cert-renew.timer
```

## Verification

```bash
curl --fail --show-error https://123.56.135.150/healthz
curl --fail --show-error https://123.56.135.150/dev/healthz
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://123.56.135.150/api/device/status)" = 404
openssl s_client -connect 123.56.135.150:443 -servername 123.56.135.150 \
  </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName
```

The Nginx file exposes only the four exact Gateway routes. In particular,
`/api/device/*`, route suffixes, and all other paths return 404.
