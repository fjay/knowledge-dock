# 部署与交付指南

---

## 规划宿主机持久化目录

为确保容器生命周期与镜像重建过程中业务数据与检查点基线不丢失，所有持久化数据统一收敛在宿主机环境变量 `KNOWLEDGE_DATA_DIR`（默认为 `/data/knowledge`）所指定的目录下。

在宿主机终端执行以下命令创建标准持久化目录结构：

```bash
mkdir -p /data/knowledge/{state,workspace,inbox,config,certs,logs,remotes}
```

各子目录规划与职责说明：
- 状态存储目录 `state/`：挂载至容器 `/root/.actiondock`，用于持久化检查点数据库（`global.db`）与容器专用的已知主机指纹文件（`known_hosts`）。该目录承载全局检查点基线与主机认证指纹，若意外丢失将导致检查点基线重置，引发全量重新扫描。
- 工作区目录 `workspace/`：挂载至容器 `/srv/workspace`，用于托管所有纳管的业务代码仓与系统知识仓。
- 待审池目录 `inbox/`：挂载至容器 `/srv/knowledge-inbox`，用于接收外部提交的排障候选经验文件，与正式知识工作区保持物理隔离。
- 配置目录 `config/`：挂载至容器 `/etc/actiondock`，用于存放多仓库清单配置文件 `repos.json`。
- 证书目录 `certs/`：挂载至容器 `/etc/actiondock/certs:ro`，用于挂载正式 TLS 证书文件（`cert.pem` 与 `key.pem`）。若留空，服务容器启动时将自动生成高强度自签名证书。
- 日志目录 `logs/`：挂载至容器 `/var/log/actiondock`，记录服务访问日志与特权维护执行日志。
- 演练仓目录 `remotes/`：挂载至容器 `/data/knowledge/remotes`，用于离线测试或演练场景的 Git 裸仓。

---

## 环境变量与安全配置规范

复制环境配置模板并生成高强度随机令牌：

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `.env` 文件，填入生成的随机字符串与本地路径配置：

```dotenv
# 查询视图令牌 (面向外部用户与业务助手，仅具备只读检索与经验追加权限)
ACTIONDOCK_TOKEN=e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2

# 特权维护视图令牌 (面向维护智能体与调度控制平面，具备文件编辑与检查点推进权限)
ACTIONDOCK_AGENT_TOKEN=f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3

# 服务对外监听端口 (默认为 443)
PORT=443

# 宿主机持久化根目录
KNOWLEDGE_DATA_DIR=/data/knowledge

# 宿主机 SSH 密钥目录
SSH_DIR=/root/.ssh

# Git 提交身份凭据
GIT_AUTHOR_NAME="Knowledge Maintainer"
GIT_AUTHOR_EMAIL="maintainer@actiondock.local"
```

安全设计约束说明：
- 双令牌安全隔离机制：只读查询令牌与特权维护令牌在权限范围上完全互斥。容器启动自举脚本内嵌安全校验规则：两个令牌均必须配置、长度必须达到 32 字符以上、两者严禁相同，且严禁使用默认占位符，否则直接终止启动流程。
- 私钥只读挂载与已知主机指纹解耦持久化：宿主机私钥目录采用只读模式（`:ro`）挂载进容器，使容器具备拉取与推送 Git 仓库凭据的同时，从底层杜绝容器进程对宿主机私钥进行篡改；已知主机指纹文件 `known_hosts` 重定向至独立的持久化目录 `state/`，当容器连接新 Git 平台时自动记录主机指纹并持久留存，服务重启不丢失，同时避免污染宿主机原生指纹配置。

---

## 配置纳管仓库清单

在 `/data/knowledge/config/repos.json` 文件中配置需要维护的代码仓列表：

```json
[
  {
    "path": "/srv/workspace/order-service",
    "url": "git@github.com:example/order-service.git",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/system-knowledge",
    "url": "git@github.com:example/system-knowledge.git",
    "repoType": "system_knowledge",
    "sourceBranch": "master"
  }
]
```

核心字段规范说明：
- 路径 `path`：容器内工作区绝对路径，统一以 `/srv/workspace/` 为前缀。
- 地址 `url`：Git 仓库远端克隆地址。首次执行时若本地目录为空将自动克隆。
- 治理类型 `repoType`：`code` 为业务代码仓，采用双分支隔离模型；`system_knowledge` 为全局系统知识仓，采用单分支直接更新模型。
- 主干分支 `sourceBranch`：主干业务代码分支（如 `release`、`main` 或 `master`）。
- 知识分支 `knowledgeBranch`：专门承载工程知识体系的分支（通常命名为 `docs`，仅 `code` 类型必需）。

---

## 容器构建与编排启动

构建镜像并启动容器服务：

```bash
docker compose up -d --build
```

查看容器运行状态：

```bash
docker compose ps
```

查看实时运行日志：

```bash
docker compose logs -f knowledge-server
```

日志输出单端口虚拟视图就绪信息后，表明 443 端口已正常对外提供服务。

---

## 客户端配置与功能验证

在客户端执行机注册视图配置并执行功能验证：

```bash
# 注册面向外部用户与查询助手的只读查询配置 (sk)
ad profile add sk -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_TOKEN> -k -d "知识中枢只读查询服务"

# 注册面向维护智能体的特权维护配置 (skm)
ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识中枢特权维护服务"
```

验证全文正则检索与经验追加：

```bash
# 验证代码与文档全文正则检索
ad run workspace/search.rg --profile sk -- pattern="OrderController"

# 验证排障经验结构化追加至待审池
ad run knowledge/knowledge.collect --profile sk -- title="超时重试排障" content="遇到超时需开启指数退避重试..."
```

验证权限安全隔离（反向测试）：

```bash
# 在只读查询配置下尝试调用写操作，命令将被白名单机制直接拦截并报错
ad run workspace/files.write --profile sk -- path="order-service/test.md" content="hack"
```

---

## 常见排障速查

- 端口连通性异常：
  - 检查宿主机防火墙是否放行 443 端口；
  - 检查云服务器控制台的安全组规则，确认允许来源 IP 访问 TCP 443 端口；
  - 若宿主机 443 端口已被占用，可在 `.env` 中修改为 `PORT=8443`，并执行 `docker compose up -d` 重新映射。
- Git 同步认证失败：
  - 检查宿主机私钥文件权限是否为 600（`chmod 600 /root/.ssh/id_rsa`）；
  - 进入容器执行握手测试：`docker compose exec knowledge-server ssh -T git@<git-host>`；
  - 确认该私钥在代码托管平台拥有对应仓库的推送写入权限。
- TLS 证书不受信任警告：
  - 若使用自动生成的自签名证书，ActionDock 命令行在注册或调用时必须附加 `-k` 选项跳过证书校验；
  - 若使用企业正式证书，将 `cert.pem` 与 `key.pem` 放置在宿主机 `$KNOWLEDGE_DATA_DIR/certs/` 目录下，并执行 `docker compose restart knowledge-server` 重启生效。
- 容器启动后异常退出：
  - 执行 `docker compose logs knowledge-server` 查看日志；
  - 检查 `.env` 文件中的两个令牌是否均已设置、互不相同、长度均达到 32 字符以上，且未包含默认占位符。
- 双分支合并冲突导致同步中止：
  - 进入容器对应仓库工作区执行 `git status`；
  - 排查是否在知识分支误改业务代码；执行 `git merge --abort` 安全回滚恢复初始状态，交由智能体进行上下文语义消解。
