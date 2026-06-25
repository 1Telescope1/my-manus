# 1. 使用 Ubuntu 基础镜像承载沙箱运行环境。
FROM ubuntu:22.04

# 2. 安装过程避免交互式提示，并设置容器主机名。
ENV DEBIAN_FRONTEND=noninteractive
ENV HOSTNAME=sandbox
ENV NODE_ENV=development
ENV PORT=8080

# 3. 将 Ubuntu 默认 apt 软件源统一换成阿里云镜像源。
RUN sed -i 's|http://archive.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list && \
    sed -i 's|http://security.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list && \
    sed -i 's|http://ports.ubuntu.com/ubuntu-ports/|http://mirrors.aliyun.com/ubuntu-ports/|g' /etc/apt/sources.list

# 4. 安装基础工具、进程管理器、虚拟显示和 VNC/CDP 相关组件。
RUN apt-get update && apt-get install -y \
    sudo bc curl wget gnupg ca-certificates software-properties-common supervisor \
    xterm socat xvfb x11vnc websockify \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 5. 创建 ubuntu 用户并授予 sudo 权限。
RUN useradd -m -d /home/ubuntu -s /bin/bash ubuntu && \
    echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu

# 6. 安装 Node.js 24.x，并使用 npm 镜像源。
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs && \
    npm config set registry https://registry.npmmirror.com && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 7. 安装 Chromium 浏览器。
RUN add-apt-repository ppa:xtradeb/apps -y && \
    apt-get update && \
    apt-get install -y chromium --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 8. 安装中文字体和语言环境。
RUN apt-get update && apt-get install -y \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    language-pack-zh-hans \
    locales \
    && locale-gen zh_CN.UTF-8 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 9. 设置默认编码。
ENV LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8

# 10. 设置工作空间。
WORKDIR /sandbox

# 11. 先复制依赖清单并安装依赖，便于 Docker 构建缓存复用。
COPY package*.json ./
RUN npm ci

# 12. 复制当前项目文件。
COPY . .

# 13. 将 supervisord 配置复制到服务配置目录。
COPY supervisord.conf /etc/supervisor/conf.d/sandbox.conf

# 14. 暴露沙箱服务、CDP、VNC 和 WebSocket VNC 端口。
EXPOSE 8080 9222 5900 5901

# 15. 允许通过环境变量追加启动参数。
ENV CHROME_ARGS=""
ENV APP_ARGS=""

# 16. 使用 supervisord 管理所有沙箱进程。
CMD ["supervisord", "-n", "-c", "/sandbox/supervisord.conf"]
