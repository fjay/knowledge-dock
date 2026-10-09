# knowledge-dock
# 云主机 Dockerfile - 知识库自动维护与反馈闭环服务端
# ==============================================================================
FROM node:25-bookworm-slim

LABEL maintainer="ActionDock Knowledge Team"
LABEL description="ActionDock Knowledge Server (Read, Append, Privileged Maintenance Planes)"

# 构建参数：支持自定义 APT 镜像源（内网/隔离环境可传入内部镜像地址，例如 mirrors.tuna.tsinghua.edu.cn）
ARG APT_MIRROR=deb.debian.org
# 构建参数：是否内置 Chromium 无头浏览器（browse/渲染类扩展包需要时置为 true，体积约增 600MB）
ARG WITH_CHROMIUM=false

# 安装必要的系统底层工具：git (带 partial clone 支持), ripgrep (search.rg 引擎), ssh, ca-certificates
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    openssh-client \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 可选层：内置 Chromium 无头浏览器与中文/日文/韩文字体（--no-install-recommends 已裁剪
# 桌面推荐包；systemd/dbus 等拉入组件是 chromium 对 systemd-sysv 的硬依赖，无法剔除）。
# 构建期执行一次无头自检，浏览器不可用则构建失败而非运行时才暴露
RUN if [ "${WITH_CHROMIUM}" = "true" ]; then \
        apt-get update && \
        apt-get install -y --no-install-recommends chromium fonts-noto-cjk && \
        rm -rf /var/lib/apt/lists/* && \
        chromium --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<h1>ok</h1>' >/dev/null && \
        chromium --version; \
    fi

# 配置 Git 全局安全目录与维护者基础身份，防止挂载卷在多用户/容器内外引发 dubious ownership 拦截
RUN git config --global --add safe.directory '*' && \
    git config --global user.name "Knowledge Maintainer" && \
    git config --global user.email "maintainer@actiondock.local"

# 内网 npm 源使用自签证书，需关闭 TLS 校验才能拉取
RUN npm config set strict-ssl false && \
    npm install -g @actiondock/cli@2.13.0 && \
    npm cache clean --force

# 创建 Monorepo 应用目录并拷贝 package.json 与 packages
WORKDIR /app

COPY package*.json ./
COPY server/packages ./server/packages

# 安装工作空间生产依赖（内网自签证书源，显式关闭 TLS 校验，不依赖全局配置）
RUN npm install --omit=dev --strict-ssl=false && npm cache clean --force

# 链接本地 packages 至 ActionDock 全局路由
RUN ad link /app/server/packages/knowledge-workspace && \
    ad link /app/server/packages/knowledge-inbox && \
    ad link /app/server/packages/knowledge-maintenance

# 创建标准挂载目录与日志目录
RUN mkdir -p /srv/workspace /srv/knowledge-inbox /etc/actiondock /var/log/actiondock

# 默认运行环境变量（包含只读查询视图 sk 允许调用的 Action 清单）
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=443 \
    WORKSPACE_ROOT=/srv/workspace \
    KNOWLEDGE_INBOX_ROOT=/srv/knowledge-inbox \
    GIT_BLOBLESS_FETCH=true \
    SK_ACTION_ALLOWLIST="workspace/search.rg,workspace/files.read,workspace/files.list,knowledge/knowledge.collect,knowledge/knowledge.get,knowledge/knowledge.query,knowledge/knowledge.leaderboard,search.rg,files.read,files.list,knowledge.collect,knowledge.get,knowledge.query,knowledge.leaderboard"

# 暴露原生 HTTPS 端口 (443 单端口多视图服务)
EXPOSE 443

# 拷贝容器启动入口与视图权限解析器
COPY server/entrypoint.sh /entrypoint.sh
COPY server/views-bootstrap.cjs /app/server/views-bootstrap.cjs
RUN chmod +x /entrypoint.sh

WORKDIR /srv

ENTRYPOINT ["/entrypoint.sh"]
