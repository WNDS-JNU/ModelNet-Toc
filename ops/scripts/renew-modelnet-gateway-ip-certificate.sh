#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-production}"
LEGO_BIN="${LEGO_BIN:-/usr/local/bin/lego-v5}"
GATEWAY_IP="${MODELNET_GATEWAY_IP:-123.56.135.150}"
RENEW_BEFORE_DAYS="${MODELNET_GATEWAY_RENEW_BEFORE_DAYS:-3}"

: "${MODELNET_GATEWAY_CERT_EMAIL:?MODELNET_GATEWAY_CERT_EMAIL must be set}"

if ! [[ "${RENEW_BEFORE_DAYS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "MODELNET_GATEWAY_RENEW_BEFORE_DAYS must be a positive integer" >&2
  exit 2
fi

case "${MODE}" in
  production)
    LEGO_SERVER="letsencrypt"
    LEGO_PATH="/etc/lego-ip"
    CERT_NAME="modelnet-gateway-ip"
    ;;
  staging)
    LEGO_SERVER="letsencrypt-staging"
    LEGO_PATH="/etc/lego-ip-staging"
    CERT_NAME="modelnet-gateway-ip-staging"
    ;;
  *)
    echo "usage: $0 [production|staging]" >&2
    exit 2
    ;;
esac

CERT_FILE="${LEGO_PATH}/certificates/${CERT_NAME}.crt"
KEY_FILE="${LEGO_PATH}/certificates/${CERT_NAME}.key"
RENEW_BEFORE_SECONDS=$((RENEW_BEFORE_DAYS * 86400))

if [[ -s "${CERT_FILE}" && -s "${KEY_FILE}" ]] &&
  /usr/bin/openssl x509 -checkend "${RENEW_BEFORE_SECONDS}" -noout -in "${CERT_FILE}" >/dev/null; then
  echo "ModelNet Gateway IP certificate is valid for more than ${RENEW_BEFORE_DAYS} days"
  exit 0
fi

nginx_was_active=0
backup_dir=""
had_existing_certificate=0

restore_nginx_and_certificate() {
  local status=$?
  local restore_status=0

  trap - EXIT

  if (( status != 0 )) && (( had_existing_certificate == 1 )); then
    /usr/bin/install -m 0644 "${backup_dir}/certificate.crt" "${CERT_FILE}" || restore_status=$?
    /usr/bin/install -m 0600 "${backup_dir}/certificate.key" "${KEY_FILE}" || restore_status=$?
  fi

  if (( nginx_was_active == 1 )); then
    /usr/bin/systemctl start nginx || restore_status=$?
  fi

  if [[ -n "${backup_dir}" ]]; then
    /usr/bin/rm -rf "${backup_dir}"
  fi

  if (( status == 0 )) && (( restore_status != 0 )); then
    status=${restore_status}
  fi

  exit "${status}"
}

trap restore_nginx_and_certificate EXIT

if [[ -s "${CERT_FILE}" && -s "${KEY_FILE}" ]]; then
  backup_dir="$(/usr/bin/mktemp -d)"
  /usr/bin/cp -p "${CERT_FILE}" "${backup_dir}/certificate.crt"
  /usr/bin/cp -p "${KEY_FILE}" "${backup_dir}/certificate.key"
  had_existing_certificate=1
fi

if /usr/bin/systemctl is-active --quiet nginx; then
  nginx_was_active=1
  /usr/bin/systemctl stop nginx
fi

lego_args=(
  --accept-tos
  --server "${LEGO_SERVER}"
  --email "${MODELNET_GATEWAY_CERT_EMAIL}"
  --domains "${GATEWAY_IP}"
  --cert.name "${CERT_NAME}"
  --path "${LEGO_PATH}"
  --profile shortlived
  --tls
  --tls.address :443
)

if (( had_existing_certificate == 1 )); then
  "${LEGO_BIN}" "${lego_args[@]}" renew \
    --days "${RENEW_BEFORE_DAYS}" \
    --no-random-sleep
else
  "${LEGO_BIN}" "${lego_args[@]}" run
fi

/usr/sbin/nginx -t
