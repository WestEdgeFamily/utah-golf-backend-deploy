#!/usr/bin/env bash
# exit on error
set -o errexit

# Skip Puppeteer Chromium download
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Install dependencies
npm ci --omit=dev