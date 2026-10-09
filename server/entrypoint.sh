#!/usr/bin/env bash
# ==============================================================================
# entrypoint.sh - knowledge-dock 容器启动脚本
# ==============================================================================
set -e

# 1. SSH 与 Git 身份准备：密钥目录由宿主机保证只读挂载，容器通过 GIT_SSH_COMMAND 接受新主机指纹，
#    指纹库落在可写的持久化目录，与宿主机 .ssh 完全解耦
KNOWN_HOSTS="${KNOWLEDGE_STATE_DIR:-/root/.actiondock}/known_hosts"
mkdir -p "$(dirname "${KNOWN_HOSTS}")" 2>/dev/null || true
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}"

if [ -n "${GIT_AUTHOR_NAME}" ]; then
    git config --global user.name "${GIT_AUTHOR_NAME}"
fi
if [ -n "${GIT_AUTHOR_EMAIL}" ]; then
    git config --global user.email "${GIT_AUTHOR_EMAIL}"
fi

# 2. 配置 ActionDock 运行时全局配置
ad config set -g WORKSPACE_ROOT "${WORKSPACE_ROOT:-/srv/workspace}" >/dev/null 2>&1 || true
ad config set -g KNOWLEDGE_INBOX_ROOT "${KNOWLEDGE_INBOX_ROOT:-/srv/knowledge-inbox}" >/dev/null 2>&1 || true
if [ -n "${GIT_AUTHOR_NAME}" ]; then
    ad config set -g GIT_AUTHOR_NAME "${GIT_AUTHOR_NAME}" >/dev/null 2>&1 || true
fi
if [ -n "${GIT_AUTHOR_EMAIL}" ]; then
    ad config set -g GIT_AUTHOR_EMAIL "${GIT_AUTHOR_EMAIL}" >/dev/null 2>&1 || true
fi

# 确保 Monorepo packages 已链接到 ActionDock 全局路由 (幂等保障，失败时告警不阻断启动)
if [ -d "/app/server/packages" ]; then
    ad link /app/server/packages/knowledge-workspace >/dev/null 2>&1 || echo "[WARN] ad link knowledge-workspace failed, falling back to build-time registry" >&2
    ad link /app/server/packages/knowledge-inbox >/dev/null 2>&1 || echo "[WARN] ad link knowledge-inbox failed, falling back to build-time registry" >&2
    ad link /app/server/packages/knowledge-maintenance >/dev/null 2>&1 || echo "[WARN] ad link knowledge-maintenance failed, falling back to build-time registry" >&2
fi

# 扫描扩展包目录：每个含 actiondock.json 的子目录自动安装生产依赖并 ad link。
# 无 dependencies 的源码型包跳过 npm install，避免隔离网络下无谓的registry访问。
# 依赖安装失败时告警不阻断：源码型无依赖包仍可正常 link，有依赖包的失败会在调用时暴露。
EXTENSIONS_DIR="${EXTENSIONS_DIR:-/srv/extensions}"
if [ -d "${EXTENSIONS_DIR}" ]; then
    for pkg_dir in "${EXTENSIONS_DIR}"/*/; do
        [ -f "${pkg_dir%/}/actiondock.json" ] || continue
        pkg_name=$(basename "${pkg_dir%/}")
        has_deps=$(node -e "const p=require('${pkg_dir%/}/package.json');process.stdout.write(p.dependencies?\"1\":\"0\")" 2>/dev/null || echo "0")
        if [ "${has_deps}" = "1" ] && [ ! -d "${pkg_dir%/}/node_modules" ]; then
            echo "[INFO] Installing dependencies for extension: ${pkg_name}"
            (cd "${pkg_dir%/}" && npm install --omit=dev --no-audit --no-fund --prefer-offline --strict-ssl=false >/dev/null 2>&1) \
                || echo "[WARN] npm install failed for extension ${pkg_name}, package may not load at runtime" >&2
        fi
        ad link "${pkg_dir%/}" >/dev/null 2>&1 \
            && echo "[INFO] Linked extension package: ${pkg_name}" \
            || echo "[WARN] ad link extension ${pkg_name} failed" >&2
    done
fi

# 3. 如果通过 docker run / docker exec 传入了自定义命令，则直接执行该命令
if [ "$#" -gt 0 ] && [ "$1" != "serve" ]; then
    exec "$@"
fi

# 4. 强约束安全校验：ACTIONDOCK_TOKEN 与 ACTIONDOCK_AGENT_TOKEN 必须存在且长度 >= 32 且互不相同
if [ -z "${ACTIONDOCK_TOKEN}" ] || [ "${#ACTIONDOCK_TOKEN}" -lt 32 ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_TOKEN must be set and contain at least 32 characters." >&2
    exit 1
fi

if [ -z "${ACTIONDOCK_AGENT_TOKEN}" ] || [ "${#ACTIONDOCK_AGENT_TOKEN}" -lt 32 ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_AGENT_TOKEN must be set and contain at least 32 characters." >&2
    exit 1
fi

if [ "${ACTIONDOCK_TOKEN}" = "${ACTIONDOCK_AGENT_TOKEN}" ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_TOKEN and ACTIONDOCK_AGENT_TOKEN must not be identical." >&2
    exit 1
fi

# 检查是否使用了已知公开的示例占位符 Token
for token in "${ACTIONDOCK_TOKEN}" "${ACTIONDOCK_AGENT_TOKEN}"; do
    case "${token}" in
        *your-random-secure*|*your-token-here*|*example-token*|*changeme*)
            echo "[SECURITY ERROR] Detected insecure default/example placeholder token. Please generate high-strength random tokens using: openssl rand -hex 32" >&2
            exit 1
            ;;
    esac
done

# 5. 启动常驻单端口虚拟视图 HTTP 服务 (原生单端口多视图 Virtual Views 模式)
PORT="${PORT:-443}"
echo "============================================================"
echo "Starting ActionDock Knowledge Server (Single-Port Virtual Views Mode)"
echo "Port:           ${PORT} (HTTPS, Virtual Views)"
echo "Timezone:       ${TZ:-Asia/Shanghai}"
echo "Workspace Root: ${WORKSPACE_ROOT:-/srv/workspace}"
echo "Inbox Root:     ${KNOWLEDGE_INBOX_ROOT:-/srv/knowledge-inbox}"
echo "============================================================"

# TLS 证书公共参数配置
TLS_FLAGS=""
CERT_FILE="${ACTIONDOCK_TLS_CERT:-/etc/actiondock/certs/cert.pem}"
KEY_FILE="${ACTIONDOCK_TLS_KEY:-/etc/actiondock/certs/key.pem}"

if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
    echo "[INFO] Using custom TLS certificates from ${CERT_FILE} and ${KEY_FILE}"
    TLS_FLAGS="--tls-cert ${CERT_FILE} --tls-key ${KEY_FILE}"
else
    echo "[INFO] No custom certificates provided, ad serve will auto-generate self-signed TLS certificates"
fi

# 动态构建视图权限配置：优先读取挂载到 /etc/actiondock/views.json 的原生
# ActionDock views 配置（支持裸对象、{"views":{}}、{"server":{"views":{}}} 三种形态），
# 未提供时按内置默认生成。解析与安全校验由 views-bootstrap.cjs 独立承担。
VIEWS_FILE="/run/actiondock-views.json"
MOUNTED_VIEWS="${MOUNTED_VIEWS:-/etc/actiondock/views.json}"
if [ -f "${MOUNTED_VIEWS}" ]; then
    echo "[INFO] Using mounted views config from ${MOUNTED_VIEWS}"
fi
node /app/server/views-bootstrap.cjs

# 阻断 serve 端对 ACTIONDOCK_TOKEN 的回落解析：该环境变量只允许作为 sk 视图令牌
# 的注入来源，不得成为 default 视图令牌而获得全量权限
unset ACTIONDOCK_TOKEN

exec ad serve --host 0.0.0.0 --port "${PORT:-443}" --https ${TLS_FLAGS} --views-file "${VIEWS_FILE}"

