'use strict';
// Usage: npm run hash -- 123456
// Prints a PASSCODE_HASH value to set as an environment variable.
const crypto = require('crypto');
const pin = process.argv[2];
if (!/^\d{6}$/.test(pin || '')) {
  console.error('Provide a six-digit passcode: npm run hash -- 123456');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
console.log(`scrypt$${salt}$${hash}`);
