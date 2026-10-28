import { defineConfig } from 'vitest/config';

// The market repo ships no toolchain of its own: it is a static catalogue plus a
// PowerShell packaging script, and the only JavaScript it owns is the sample
// plugin's app.js. These tests drive that file in jsdom so the handshake and the
// streaming rules are checked against a real DOM rather than by reading source.
//
// `node_modules` is a directory junction to the host repo's frontend deps (see
// README); it is git-ignored, so a clone of this repo needs the host checkout to
// run the tests. That is deliberate: the market repo must not carry a second
// copy of vitest.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    isolate: true,
  },
});
