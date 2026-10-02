#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 box for the warehouse, run as root by `just box::bootstrap <ip>`.
# Safe to run again: every step checks its state first or rewrites the same file.
set -euo pipefail

repo=https://github.com/tanghyd/wc3-gym-warehouse.git
home=/home/warehouse
just_version=1.53.0
just_sha256=7fedeb22c7e14d9ef1551e8b793700866d80f409f9884b0e80ebb65c11d4874d  # x86_64-unknown-linux-musl, from the release's SHA256SUMS
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a  # no prompts from apt or needrestart
apt=(apt-get -y -q -o DPkg::Lock::Timeout=300)  # first boot's apt timers can hold the lock

# Packages, then daily security updates by unattended-upgrades.
"${apt[@]}" update
"${apt[@]}" install ca-certificates curl git ufw unattended-upgrades
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

# Docker Engine and the compose plugin from docker.com's apt repo (docs.docker.com/engine/install/ubuntu).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
"${apt[@]}" update
"${apt[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Container logs rotate at 10 MB, 3 files each. Docker restarts only when the file changes.
daemon='{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}'
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon" ]; then
  mkdir -p /etc/docker
  echo "$daemon" > /etc/docker/daemon.json
  systemctl restart docker
fi

# Only SSH comes in. Docker's published ports skip ufw, so compose.yaml binds every port to 127.0.0.1.
ufw default deny incoming
ufw allow OpenSSH
ufw --force enable

# The warehouse user runs the stack. It logs in with root's SSH keys; the docker group is root-equivalent.
id warehouse >/dev/null 2>&1 || useradd --create-home --shell /bin/bash warehouse
usermod -aG docker warehouse
install -d -m 700 -o warehouse -g warehouse "$home/.ssh"
install -m 600 -o warehouse -g warehouse /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"

# just, pinned and checked against the release's checksum. The CX plans are x86_64.
if [ "$(just --version 2>/dev/null)" != "just $just_version" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/just.tgz" \
    "https://github.com/casey/just/releases/download/$just_version/just-$just_version-x86_64-unknown-linux-musl.tar.gz"
  echo "$just_sha256  $tmp/just.tgz" | sha256sum -c --quiet -
  tar -xzf "$tmp/just.tgz" -C "$tmp" just
  install -m 755 "$tmp/just" /usr/local/bin/just
  rm -rf "$tmp"
fi

# The repo over https with no credentials, so the box can pull but never push.
[ -d "$home/wc3-gym-warehouse/.git" ] || sudo -u warehouse git -C "$home" clone -q "$repo" wc3-gym-warehouse

echo "bootstrap done: next, BOX_SSH=warehouse@<this host> in .env, then just box::env"
