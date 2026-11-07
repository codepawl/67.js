FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git \
    libegl1 libgl1 libgl1-mesa-dri libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libxrender1 libsm6 libx11-6 libxext6 libgomp1 libwayland-client0 \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://download.blender.org/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz | tar -xJ -C /opt && mv /opt/blender-5.1.2-linux-x64 /opt/blender
RUN curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh
RUN git clone -q --branch v1.0.3 --depth 1 https://projects.blender.org/lab/blender_mcp.git /opt/blender_mcp \
 && curl -fsSL -o /opt/mcp-1.0.3.zip "https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.3/mcp-1.0.3.zip"
ENV BLENDER_PATH=/opt/blender/blender
RUN /opt/blender/blender -b --command extension install-file --enable -r user_default /opt/mcp-1.0.3.zip 2>&1 | tail -5; \
    cd /opt/blender_mcp/mcp && uv sync 2>&1 | tail -2
WORKDIR /work
