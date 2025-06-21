const frontEndPack = require('./package.json');
const backendPack = require('./backend/package.json');
const { writeFileSync } = require('node:fs');
backendPack.version = frontEndPack.version;
writeFileSync(`${__dirname}/backend/package.json`, JSON.stringify(backendPack, null, 4));
