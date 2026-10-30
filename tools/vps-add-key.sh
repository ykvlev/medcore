#!/bin/sh
# Добавляет публичный ключ развёртывания MEDCORE для пользователя root.
# Использование на сервере: curl -sL <адрес> | sh
set -e
mkdir -p /root/.ssh
chmod 700 /root/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFoF0pRnJAfVYu5tX38PnbfqPkPYNs6sJTdZMF+7wkgB medcore-deploy'
grep -qxF "$KEY" /root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo KEY_ADDED
