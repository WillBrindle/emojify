const convert = require('color-convert');
const fs = require('fs');
const sharp = require('sharp');

const { argv } = require('yargs')
  .option('input', {
    alias: 'i',
    describe: 'The input json file containing the images to use'
  })
  .option('output', {
    alias: 'o',
    describe: 'Where to save the lookup png file to',
    default: 'lookup.png'
  })
  .demandOption(['input'], 'An input file must be specified');

const LOOKUP_SIZE = 2048;
const ACCURACY = 2;
const SIZE = Math.floor(255 / ACCURACY);

const inputFile = argv.input;
const outputFile = argv.output;

const getImageColour = async (image) => {
  // Shrink image down to 1x1 pixel
  const buf = await sharp(image)
    .flatten( { background: '#ffffff' } )
    .resize(1, 1, {
      fit: 'cover',
      position: sharp.strategy.entropy,
    })
    .raw()
    .toBuffer();
  // Get colour value of the single pixel in Lab colour space
  const color = convert.rgb.lab([buf[0], buf[1], buf[2]]); 
  return { l: color[0], a: color[1], b: color[2] };
}

const generateLookupTable = async (avgColours) => {
  const buffer = await sharp({
    create: {
      width: LOOKUP_SIZE,
      height: LOOKUP_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
  .raw()
  .toBuffer();

  for (let red = 0; red < 255; red += ACCURACY) {
    for (let green = 0; green < 255; green += ACCURACY) {
      for (let blue = 0; blue < 255; blue += ACCURACY) {
        const lab = convert.rgb.lab([red, green, blue]);
        const [l, a, b] = lab;

        // Find the best match
        let bestDistSq = Number.MAX_VALUE;
        let bestImg = null;
        avgColours.forEach((img, key) => {
          const dl = l - img.l;
          const da = a - img.a;
          const db = b - img.b;
          const distSq = dl*dl + da*da + db*db;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestImg = key;
          }
        });

        // Split the resulting index into parts to be stored as rgb
        const resultR = (Number(bestImg) % 256);
        const resultG = Math.floor((Number(bestImg) / 256));

        // Figure out where to write the data to in our lookup image
        const total = Math.floor(blue / ACCURACY) + Math.floor(green / ACCURACY) * SIZE + Math.floor(red / ACCURACY) * SIZE * SIZE;
        const x = total % LOOKUP_SIZE;
        const y = Math.floor(total / LOOKUP_SIZE);
        const pos = (x * LOOKUP_SIZE + y) * 4;

        buffer[pos] = resultR;
        buffer[pos + 1] = resultG;
        buffer[pos + 3] = 255;
      }
    }
  }

  return buffer;
}

(async () => {
  console.log('Loading image map...');
  const images = JSON.parse(fs.readFileSync(inputFile))
    .map(i => {
      const base64Data = i.img.replace(/^data:image\/png;base64,/, '');
      return Buffer.from(base64Data, 'base64');
    });

  console.log('Calculating average colours...');
  const avgColours = await Promise.all(images.map(getImageColour));

  console.log('Generating lookup table...');
  const buffer = await generateLookupTable(avgColours);

  console.log(`Saving lookup table to ${outputFile}`)
  sharp(buffer, { raw: { width: LOOKUP_SIZE, height: LOOKUP_SIZE, channels: 4 } })
    .png()
    .toFile(outputFile);
})();
