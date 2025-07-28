#!/usr/bin/env bash
# exit on error
set -o errexit

echo "Starting build process..."

# Skip Puppeteer Chromium download
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

echo "Installing dependencies (skipping Chromium download)..."

# Install dependencies
npm ci --omit=dev

echo "Build completed successfully!"