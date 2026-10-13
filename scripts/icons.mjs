// Generuje ikony PNG z icon.svg (uruchamiane ręcznie po zmianie logo: node scripts/icons.mjs; wymaga pakietu sharp)
import sharp from 'sharp';
const svg = 'public/icons/icon.svg';
await sharp(svg).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(svg).resize(512, 512).png().toFile('public/icons/icon-512.png');
// maskable: logo pomniejszone na pełnym tle (bezpieczna strefa Androida)
const inner = await sharp(svg).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#121417' } })
  .composite([{ input: inner, top: 56, left: 56 }]).png().toFile('public/icons/icon-maskable-512.png');
console.log('ok');
