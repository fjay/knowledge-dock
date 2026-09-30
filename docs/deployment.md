# 部署指南

服务端以 Docker Compose 运行，在容器内监听 HTTPS 443。宿主机端口由 `.env` 的 `PORT` 映射；查询视图与维护视图共用该端口，通过不同令牌选择可调用动作。

## 准备

宿主机需要 Docker、Docker Compose、可访问纳管 Git 仓库的凭据，以及足够保存代码镜像的磁盘空间。执行机需要 Node.js 24.12.0 及以上和 ActionDock 命令行工具 `ad`。私有仓库使用 SSH 时，确认 `SSH_DIR` 指向可读取的密钥目录，且密钥已获仓库访问权限。

- 在项目根目录复制环境与仓库清单模板：

  ```bash
  cp .env.example .env
  cp server/config/repos.json.example server/config/repos.json
  openssl rand -hex 32
  openssl rand -hex 32
  ```

- 把生成的两个不同令牌填入 `.env`。它们均需至少 32 个字符。根据环境设置外部端口、数据目录和 Git 提交身份：

  ```dotenv
  ACTIONDOCK_TOKEN=<查询令牌>
  ACTIONDOCK_AGENT_TOKEN=<维护令牌>
  PORT=443
  KNOWLEDGE_DATA_DIR=/data/knowledge
  SSH_DIR=/root/.ssh
  GIT_AUTHOR_NAME="Knowledge Maintainer"
  GIT_AUTHOR_EMAIL="maintainer@example.com"
  APT_MIRROR=deb.debian.org
  ```

若处于内网或隔离网络环境，构建镜像时可通过 `APT_MIRROR` 指定内部 Debian 镜像源（如 `mirrors.tuna.tsinghua.edu.cn`），构建参数会自动替换软件源地址；对于离线封闭环境，建议直接基于已完成换源的基础镜像构建。

`ACTIONDOCK_TOKEN` 允许检索和向待审池追加候选；`ACTIONDOCK_AGENT_TOKEN` 允许编辑、终端执行和仓库维护。不要将维护令牌交给外部查询用户。

## 仓库清单

编辑项目中的 `server/config/repos.json`。Compose 将整个 `server/config/` 挂载到容器的 `/etc/actiondock/`，维护动作默认读取 `/etc/actiondock/repos.json`。仓库清单不在 `KNOWLEDGE_DATA_DIR/config/` 下。

```json
[
  {
    "path": "/srv/workspace/order-service",
    "url": "git@example.com:team/order-service.git",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/system-knowledge",
    "url": "git@example.com:team/system-knowledge.git",
    "repoType": "system_knowledge",
    "sourceBranch": "main"
  }
]
```

`path` 是容器内工作区路径，须位于 `/srv/workspace/` 下。`url` 用于首次克隆；`sourceBranch` 指向业务主干或系统知识仓主干；业务仓还需指定 `knowledgeBranch`。示例地址必须替换为实际可访问的远端。若已有仓库位于工作区且清单不存在，维护动作可以扫描并生成清单；新环境建议显式配置，避免依赖目录名推断类型和分支。

## 数据目录与证书

Compose 从 `KNOWLEDGE_DATA_DIR` 挂载以下目录：

| 宿主机子目录 | 容器位置 | 内容 |
|---|---|---|
| `state/` | `/root/.actiondock` | ActionDock 状态、检查点与 SSH 主机指纹 |
| `workspace/` | `/srv/workspace` | 纳管仓库镜像 |
| `inbox/` | `/srv/knowledge-inbox` | 待审与已归档候选 |
| `certs/` | `/etc/actiondock/certs`，只读 | 可选的 `cert.pem` 与 `key.pem` |
| `logs/` | `/var/log/actiondock` | 供运行环境使用的日志目录 |
| `remotes/` | `/data/knowledge/remotes` | 本地演练用裸仓目录 |

若未提供证书，`ad serve` 会生成自签名证书。生产接入应提供受信任证书，并让客户端正常校验证书。SSH 密钥目录以只读方式挂载，防止容器修改宿主机密钥文件；运行进程仍可读取该密钥，因此维护令牌和服务端主机都属于受信任边界。首次 SSH 连接使用 `StrictHostKeyChecking=accept-new`，需要严格固定主机指纹的环境应预先核验并配置 `state/known_hosts`。

## 启动与验证

```bash
docker compose up -d --build
docker compose ps
docker compose logs knowledge-server
```

在执行机注册远端视图。以下示例的 `-k` 仅适用于自签名证书环境；正式证书不使用该选项。

```bash
ad profile add sk -s https://<服务地址>:443 -t <查询令牌> -k
ad profile add skm -s https://<服务地址>:443 -t <维护令牌> -k
```

先同步仓库，再检查扫描状态与查询权限：

```bash
ad run maintenance/maintenance.sync --profile skm
ad run maintenance/maintenance.list --profile skm
ad run workspace/files.list --profile sk -- path="." depth:=1
```

同步动作可能创建业务仓知识分支并推送到远端。执行前确认仓库地址、分支及推送权限。首次扫描没有检查点时显示 `initial`，这表示需要进行初始知识盘点，并非同步失败。

可以用查询视图尝试调用 `workspace/files.write`，确认服务拒绝该动作；不要在验证命令中携带真实可写目标。维护视图下的终端动作具有较高权限，不用于公开可达的日常查询。

## 常见故障

| 现象 | 首先核对 |
|---|---|
| 容器启动即退出 | 两枚令牌是否缺失、过短、相同或仍为模板占位符；查看 `docker compose logs knowledge-server` |
| 镜像构建时 APT 报错或连接超时 | 核对 `.env` 中的 `APT_MIRROR` 是否正确指向可用镜像源；或预先制作内网基础镜像 |
| 客户端证书报错 | 证书是否受信任、服务地址是否匹配；自签名环境可暂用 `-k` |
| 仓库克隆失败 | 清单 `url`、密钥权限、仓库授权和 SSH 主机指纹 |
| `maintenance.list` 没有仓库 | `server/config/repos.json` 是否存在、路径是否正确、仓库是否已经同步 |
| 分支冲突 | 读取 `maintenance.sync` 返回的 `conflictFiles`，由维护人员核对后处理；不要强制覆盖 |

批量维护与实际智能体派发见[编排指南](orchestration.md)，运行中检查见[运维手册](operations.md)。
