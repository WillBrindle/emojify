const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const rimraf = require('rimraf');
const sharp = require('sharp');

const { argv } = require('yargs')
  .option('input', {
    alias: 'i',
    describe: 'The input file containing the images to use'
  })
  .option('map', {
    alias: 'm',
    describe: 'The emojis map json file'
  })
  .option('lookup', {
    alias: 'l',
    describe: 'Lookup table to use'
  })
  .option('target-width', {
    alias: 'w'
  })
  .demandOption(['input', 'map', 'lookup']);

const lookupImg = argv.lookup;
const inputImg = argv.input;
const emojiMap = JSON.parse(fs.readFileSync(argv.map));
const targetWidth = argv['target-width'];

const FRAMES_FOLDER = `/tmp/frames`;
const LOOKUP_SIZE = 2048;
const ACCURACY = 2;

const getLookupPos = (r, g, b) => {
  const size = Math.floor(255 / ACCURACY);
  const total = Math.floor(b / ACCURACY) + Math.floor(g / ACCURACY) * size + Math.floor(r / ACCURACY) * size * size;
  const lookupX = total % LOOKUP_SIZE;
  const lookupY = Math.floor(total / LOOKUP_SIZE);
  const pos = (lookupX * LOOKUP_SIZE + lookupY) * 4;

  return pos;
}

const getEmojisForImage = async (img, targetWidth, lookupBuffer, emojiMap) => {
  const image = sharp(img);
  const metadata = await image.metadata();

  const resolution = Math.max(1, targetWidth ? Math.floor(metadata.width / targetWidth) : 1);

  const width = Math.floor(metadata.width / resolution);
  const height = Math.floor(metadata.height / resolution);
  const channels = metadata.channels;
  
  const buffer = await image
    .resize(width, height)
    .raw()
    .toBuffer();

  const res = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = (y * width + x) * channels;
      const r = buffer[pos], g = buffer[pos + 1], b = buffer[pos + 2];

      const lookupPos = getLookupPos(r, g, b);

      const indexR = lookupBuffer[lookupPos];
      const indexG = lookupBuffer[lookupPos + 1];
      const index = indexG * 256 + indexR;

      res.push(emojiMap[index]);
    }
  }

  return {
    width,
    height,
    pixels: res,
  }
}

(async () => {
  rimraf.sync(FRAMES_FOLDER);
  fs.mkdirSync(FRAMES_FOLDER);

  // console.log('Loading lookup buffer...');
  const lookupBuffer = await sharp(lookupImg)
    .raw()
    .toBuffer();

  let inputs = [];
  let cleanup = false;

  if (inputImg.endsWith('.gif') || inputImg.endsWith('.mp4')) {
    // console.log('Decoding frames...');
    await new Promise((resolve, reject) => {
      ffmpeg(inputImg)
        .output(`${FRAMES_FOLDER}/frame%05d.jpg`)
        .fps(0.04)
        .on('error', (err) => {
          reject(err)
        })
        .on('end', () => {
          resolve();
        })
        .run();
    });

    const frames = fs.readdirSync(FRAMES_FOLDER);
    frames.sort();

    inputs = frames.map(frame => `${FRAMES_FOLDER}/${frame}`);
    cleanup = true;
  } else {
    // console.log('Using single image...')
    inputs = [ inputImg ];
  }

  let width = null, height = null;

  await Promise.all(inputs.map(async (frame) => {
    const result = await getEmojisForImage(frame, targetWidth, lookupBuffer, emojiMap);

    if (!width && !height) {
      width = result.width;
      height = result.height;

      console.log(width, height);
    }

    const emojis = result.pixels.map(emoji => emoji.code.split(' ')
        .map(str => {
          return str.replace('U+', '&#x') + ';';
        })
        .join('')
      );

    console.log(emojis.join(','));
  }));

  if (cleanup) {
    rimraf.sync(FRAMES_FOLDER);
  }
})();
