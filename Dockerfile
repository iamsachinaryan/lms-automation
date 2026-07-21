# =============================================================================
# Stage 1: Builder — installs dependencies
# =============================================================================
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# =============================================================================
# Stage 2: Runtime — minimal image with Chromium dependencies
# =============================================================================
FROM node:20-slim AS runtime

# Install Chrome/Chromium system dependencies
# These are required for Puppeteer's bundled Chromium to run on Linux
RUN apt-get update && apt-get install -y \
    # Core graphics libraries
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    # Font support
    fonts-liberation \
    fonts-noto-color-emoji \
    # NSS for SSL
    libnss3 \
    libnspr4 \
    # Sandbox + security
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libasound2 \
    libdbus-1-3 \
    libexpat1 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    # Misc
    wget \
    ca-certificates \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r automator && useradd -r -g automator -G audio,video automator \
    && mkdir -p /home/automator /app \
    && chown -R automator:automator /home/automator /app

WORKDIR /app

# Copy installed node_modules from builder
COPY --from=builder --chown=automator:automator /app/node_modules ./node_modules

# Copy source code and public directory
COPY --chown=automator:automator setup.js server.js video-manager.js package.json ./
COPY --chown=automator:automator public/ ./public/

# Create runtime directories
RUN mkdir -p screenshots logs && chown -R automator:automator screenshots logs

# Switch to non-root user
USER automator

# Set Puppeteer to use system Chrome path (or bundled)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
