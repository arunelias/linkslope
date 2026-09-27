/**
 * @file Bundles the React extension with local fonts/styles and relative asset URLs.
 * Files under public are copied as-is, including the manifest and service worker.
 */
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
});
