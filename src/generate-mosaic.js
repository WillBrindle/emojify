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
  .options('text', {
    alias: 't',
    describe: 'output as text'
  })
  .options('output', {
    alias: 'o',
    describe: 'output file'
  })
  .demandOption(['input', 'map', 'lookup']);

const lookupImg = argv.lookup;
const inputImg = argv.input;
const emojiMap = JSON.parse(fs.readFileSync(argv.map));
const targetWidth = argv['target-width'];
const output = argv.output;
const textOutput = argv.text;

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
  let videoInput = false;

  if (inputImg.endsWith('.gif') || inputImg.endsWith('.mp4')) {
    videoInput = true;
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

    fs.mkdirSync(output);
  } else {
    // console.log('Using single image...')
    inputs = [ inputImg ];
  }

  let headerPrinted = false;

  await Promise.all(inputs.map(async (frame, frameInd) => {
    const result = await getEmojisForImage(frame, targetWidth, lookupBuffer, emojiMap);

    if (textOutput) {
      // Just print out the unicode charaacter
      const emojis = result.pixels.map(emoji => emoji.code.split(' ')
          .map(str => {
            return str.replace('U+', '&#x') + ';';
          })
          .join('')
        );

      if (!headerPrinted) {
        console.log(result.width, result.height);
        headerPrinted = true;
      }
      console.log(emojis.join(','));
    } else {
      // Create buffer
      const finalWidth = result.width * 72;
      const finalHeight = result.height * 72;
      const buffer = await sharp({
          create: {
            width: finalWidth,
            height: finalHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        })
        .raw()
        .toBuffer();

      // Generate resulting image
      await Promise.all(result.pixels.map(async (emoji, ind) => {
        const base64Data = emoji.img.replace(/^data:image\/png;base64,/, '');
        const img = sharp(Buffer.from(base64Data, 'base64'))
        //  .flatten( { background: '#ffffff' } );
        const { width, height, channels } = await img.metadata();
        const bufferIn = await img
          .raw()
          .toBuffer();

        const cornerX = 72 * (ind % result.width);
        const cornerY = 72 * (Math.floor(ind / result.width));
        for (let i = 0; i < bufferIn.length; i += channels) {
          const x = cornerX + (i / channels) % width;
          const y = cornerY + Math.floor((i / channels) / width);

          const pos = (x + y * finalWidth) * 4;
          buffer[pos] = bufferIn[i];
          buffer[pos + 1] = bufferIn[i + 1];
          buffer[pos + 2] = bufferIn[i + 2];
          buffer[pos + 3] = bufferIn[i + 3];
        }
      }));

      const frameNumber = `${frameInd}`.padStart(5, '0');
      sharp(buffer, {
          raw: {
            width: finalWidth,
            height: finalHeight,
            channels: 4
          }
        })
        .png()
        .toFile(videoInput ? `${output}/${frameNumber}.png` : output);
    }
  }));

  if (videoInput) {
    rimraf.sync(FRAMES_FOLDER);
  }
})();
