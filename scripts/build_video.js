const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const baseDir = 'D:/nexus/scratch_video';
const appData = 'C:/Users/Pos5/.gemini/antigravity/brain/aee49e07-d4dc-4fb6-a58c-bcf6044c32dd/.system_generated/steps';

const slides = [
  { src: path.join(appData, '1519/media_0.png'), dest: path.join(baseDir, 'slide1.png'), duration: 11 },
  { src: path.join(appData, '1523/media_0.png'), dest: path.join(baseDir, 'slide2.png'), duration: 13 },
  { src: path.join(appData, '1527/media_0.png'), dest: path.join(baseDir, 'slide3.png'), duration: 14 },
  { src: path.join(appData, '1531/media_0.png'), dest: path.join(baseDir, 'slide4.png'), duration: 12 },
  { src: path.join(appData, '1535/media_0.png'), dest: path.join(baseDir, 'slide5.png'), duration: 11 }
];

console.log('Copying slide images...');
for (const s of slides) {
  if (fs.existsSync(s.src)) {
    fs.copyFileSync(s.src, s.dest);
    console.log(`Copied ${s.dest}`);
  } else {
    console.error(`Source not found: ${s.src}`);
  }
}

// Create concat list for ffmpeg
const concatListPath = path.join(baseDir, 'slides.txt');
let concatContent = '';
for (const s of slides) {
  // ffmpeg concat demuxer format
  concatContent += `file '${s.dest.replace(/\\/g, '/')}'\n`;
  concatContent += `duration ${s.duration}\n`;
}
// Repeat last file without duration as required by ffmpeg concat
concatContent += `file '${slides[slides.length - 1].dest.replace(/\\/g, '/')}'\n`;

fs.writeFileSync(concatListPath, concatContent);
console.log('Wrote concat list to', concatListPath);

const audioPath = path.join(baseDir, 'voiceover.mp3');
const outVideo = path.join(baseDir, 'yc_founder_video.mp4');

// ffmpeg command to render MP4 with scale filter to guarantee even dimensions
const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -i "${audioPath}" -vf "scale=1920:1080" -c:v libx264 -pix_fmt yuv420p -r 25 -c:a aac -b:a 192k -shortest "${outVideo}"`;

console.log('Running ffmpeg encoding...');
execSync(ffmpegCmd, { stdio: 'inherit' });

console.log('Encoding complete!');
if (fs.existsSync(outVideo)) {
  const stats = fs.statSync(outVideo);
  console.log(`Success! Video created at: ${outVideo} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
}
