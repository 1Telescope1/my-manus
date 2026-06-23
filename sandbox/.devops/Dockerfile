# 1. 使用 Node 20 的 Debian slim 镜像作为沙箱开发容器基础镜像。
FROM node:20-bookworm-slim

# 2. 设置非交互安装、容器主机名、运行环境和容器内服务端口。
ENV DEBIAN_FRONTEND=noninteractive
ENV HOSTNAME=sandbox
ENV NODE_ENV=development
ENV PORT=8080

# 3. 安装基础工具和 OpenSSH Server，用于容器内开发、远程连接和依赖拉取。
# mkdir /var/run/sshd 是 SSH 服务启动所需目录。
RUN apt-get update && apt-get install -y \
    ca-certificates git curl openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /var/run/sshd

# 4. 配置 SSH 访问方式，保持当前开发容器的远程连接行为。
RUN echo 'root:root' | chpasswd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# 5. 设置容器内工作目录，docker-compose 会把项目目录挂载到这里。
WORKDIR /sandbox

# 6. 先复制依赖清单并安装依赖，便于 Docker 构建缓存复用。
COPY package*.json ./
RUN npm ci

# 7. 暴露 SSH 端口和沙箱服务端口。
EXPOSE 22 8080

# 8. 启动 SSH 服务并保持前台运行，避免容器启动后直接退出。
CMD ["/usr/sbin/sshd", "-D"]

