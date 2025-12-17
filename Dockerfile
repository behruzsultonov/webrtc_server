# Use Ubuntu as base image (recommended for mediasoup)
FROM ubuntu:20.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
  curl \
  git \
  python3 \
  python3-pip \
  build-essential \
  libtool \
  automake \
  autoconf \
  pkg-config \
  libclang-dev \
  libglib2.0-dev \
  libffi-dev \
  libpixman-1-dev \
  libcairo2-dev \
  libfreetype6-dev \
  libharfbuzz-dev \
  libjpeg-dev \
  libpng-dev \
  libgif-dev \
  libwebp-dev \
  libsqlite3-dev \
  libavcodec-dev \
  libavformat-dev \
  libavutil-dev \
  libswscale-dev \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
  && apt-get install -y nodejs

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy app source
COPY . .

# Expose ports
EXPOSE 3500 40000-49999/udp

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3500/ || exit 1

# Start the application
CMD ["npm", "start"]