const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const text = "Hi, I'm Abel Varga, solo technical founder and CTO of Swypik, based in Romania. Over the past 18 months, I have built an end-to-end autonomous commerce operating system. First, Swypik: a vertical short-video commerce platform and streaming ecosystem live at swypik.com, with over 14,000 products, 4,700 creator videos, and Stripe checkout. Second, Multi-ERP: an enterprise operating system built in Go 1.26 and React 19 that handles multi-tenant inventory, logistics, and automated government fiscal compliance with the Romanian tax authority, ANAF. And third, Ilaria and Ilaria: our proprietary sparse cognitive AI brain built with custom CUDA kernels, enabling sub-second multimodal product discovery and semantic search. We are bootstrapped, have early user traction, and we are applying to Y Combinator Winter 2027 to scale our GPU infrastructure and expand our platform across Europe and the US. Thank you!";

const outDir = path.resolve('D:/ilaria/scratch_video');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const audioPath = path.join(outDir, 'voiceover.mp3');

// Edge TTS command
const args = [
  '--voice', 'en-US-GuyNeural',
  '--rate', '+0%',
  '--text', text,
  '--write-media', audioPath
];

console.log('Running edge-tts to generate voiceover...');
execFile('edge-tts.exe', args, (error, stdout, stderr) => {
  if (error) {
    console.error('Error generating audio:', error);
    process.exit(1);
  }
  console.log('Voiceover generated successfully at:', audioPath);
  const stats = fs.statSync(audioPath);
  console.log('File size:', stats.size, 'bytes');
});
