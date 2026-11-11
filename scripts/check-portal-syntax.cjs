'use strict';
// Validación local de los recursos reales del portal. No toca la base de datos.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
let checked = 0;
for (const [, attrs, inline] of scripts) {
  const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (src && /^https?:\/\//i.test(src)) continue;
  const filename = src ? src.split('?')[0].replace(/^\.\//, '') : `index.html:inline-${checked + 1}`;
  const code = src ? fs.readFileSync(path.join(root, filename), 'utf8') : inline;
  if (!code.trim()) continue;
  new vm.Script(code, { filename });
  checked++;
}
const video = path.join(root, 'TARRACO_Tutorial_clientes_narrado.mp4');
const info = fs.statSync(video);
if (info.size < 1024) throw Error('El vídeo no contiene un archivo MP4 real.');
const header = Buffer.alloc(12);
const fd = fs.openSync(video, 'r');
try { fs.readSync(fd, header, 0, header.length, 0); }
finally { fs.closeSync(fd); }
if (header.toString('ascii', 4, 8) !== 'ftyp') throw Error('El archivo de vídeo no tiene cabecera MP4.');
const videoTag = html.match(/<video\b[^>]*id="tutorialVideo"[^>]*>/i)?.[0] || '';
if (!videoTag.includes('controls') || !videoTag.includes('preload="none"') || /\bautoplay\b/i.test(videoTag)) {
  throw Error('El tutorial debe tener controles y no reproducirse automáticamente.');
}
if (!html.includes('data-src="./TARRACO_Tutorial_clientes_narrado.mp4"')) {
  throw Error('El tutorial no apunta al vídeo real.');
}
if (!html.includes("profile.role!=='customer'")) {
  throw Error('Falta la restricción de visibilidad del tutorial a clientes.');
}
console.log(`Correcto: ${checked} scripts válidos; MP4 real (${info.size} bytes); tutorial solo bajo demanda.`);
