#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ppt:real-export-adapter', 'src/core/ppt-review/slide-exporter.ts', [
  'soffice',
  'libreoffice',
  'powerpoint_osascript',
  'partial_export',
  'slide_export_unavailable',
  'manual_slide_image_attach'
]);

emitGate('ppt:real-export-adapter', { adapters: ['LibreOffice/soffice', 'PowerPoint/osascript', 'manual_attach'] });
