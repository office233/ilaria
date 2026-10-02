'use strict';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 3)) {
  throw new Error('Swypik mobile requires Node.js >=24.3.0; use Node.js 24 LTS with synchronous require(ESM) support.');
}

// query-string 7 keeps Expo Router's API while the fixed decoder is ESM.
// This changes only the import boundary; the upstream decoder stays intact.
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const projectRequire = createRequire(join(__dirname, '..', 'package.json'));
const queryEntry = projectRequire.resolve('query-string');
const decoderEntry = createRequire(queryEntry).resolve('decode-uri-component');
const queryPackage = JSON.parse(readFileSync(join(dirname(queryEntry), 'package.json'), 'utf8'));
const decoderPackage = JSON.parse(readFileSync(join(dirname(decoderEntry), 'package.json'), 'utf8'));

if (queryPackage.version !== '7.1.3' || decoderPackage.version !== '0.5.0') {
  throw new Error('Review the query-string interop patch before changing query-string 7.1.3 or decode-uri-component 0.5.0.');
}

const source = readFileSync(queryEntry, 'utf8').replace(/\r\n/g, '\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const originalHash = 'caa3f2c8b45dfe1e91db22ae10743af68de8d96f26515132bb52485ec0f037fa';
const patchedHash = 'fc1ca6e1961ba005e554b1bc0de932d6454bf59bfaea03d02c7261dbdcafcdbd';
const sourceHash = hash(source);

if (sourceHash !== originalHash && sourceHash !== patchedHash) {
  throw new Error('Unexpected query-string source; refusing to apply the security interop patch.');
}

// Node versions supported by this React Native SDK can require synchronous ESM.
if (typeof createRequire(queryEntry)('decode-uri-component').default !== 'function') {
  throw new Error('The fixed decoder must expose its synchronous default function.');
}

if (sourceHash === originalHash) {
  const patched = source.replace(
    "const decodeComponent = require('decode-uri-component');",
    "const decodeComponent = require('decode-uri-component').default;",
  );
  if (hash(patched) !== patchedHash) {
    throw new Error('The query-string interop patch did not match its expected result.');
  }
  writeFileSync(queryEntry, patched);
}

console.log('query-string 7.1.3 uses the fixed decode-uri-component 0.5.0 default export.');
