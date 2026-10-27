const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
fs.mkdirSync('dist/ui', { recursive: true });
for (const file of fs.readdirSync('src/ui')) fs.copyFileSync(path.join('src/ui', file), path.join('dist/ui', file));
fs.mkdirSync('assets', { recursive: true });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return result; }
// Rounded #fafafa tile, #171717 bridge: deck bar, centered arch, one pier at each end.
const size = 256, pixels = Buffer.alloc((size * 4 + 1) * size);
const BACKGROUND = [0xfa, 0xfa, 0xfa], INK = [0x17, 0x17, 0x17];
const deck = (x, y) => x >= 34 && x <= 222 && y >= 54 && y <= 84;
const pier = (x, y) => (x >= 38 && x <= 68 || x >= 188 && x <= 218) && y >= 84 && y <= 202;
const arch = (x, y) => {
  if (y < 84 || y > 202) return false;
  const ox = (x - 128) / 54, oy = (y - 202) / 118, ix = (x - 128) / 30, iy = (y - 202) / 86;
  return ox * ox + oy * oy <= 1 && ix * ix + iy * iy >= 1;
};
const inked = (x, y) => deck(x, y) || pier(x, y) || arch(x, y);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const p = y * (size * 4 + 1) + 1 + x * 4;
  const corner = Math.hypot(Math.max(0, 44 - x, x - 211), Math.max(0, 44 - y, y - 211)) > 44;
  const c = [...inked(x, y) ? INK : BACKGROUND, corner ? 0 : 255];
  c.forEach((value, index) => pixels[p + index] = value);
}
// Grayscale-only is an acceptance condition; fail the build rather than ship a colored icon.
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const p = y * (size * 4 + 1) + 1 + x * 4;
  if (pixels[p + 3] !== 0 && (pixels[p] !== pixels[p + 1] || pixels[p + 1] !== pixels[p + 2])) throw new Error('图标必须是黑白灰像素。');
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('assets/icon.png', png); fs.copyFileSync('assets/icon.png', 'dist/ui/icon.png');
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[8] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync('assets/icon.ico', Buffer.concat([ico, png]));
if (process.platform === 'win32') {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  for (const [source, output] of [['PipeHost.cs','pipe-host.exe']]) {
    if (fs.existsSync(`build/${output}`) && fs.statSync(`build/${output}`).mtimeMs >= fs.statSync(`build/${source}`).mtimeMs) continue;
    execFileSync(compiler, ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.resolve('build',output)}`, path.resolve('build',source)], { stdio: 'inherit', windowsHide: true });
  }
}
