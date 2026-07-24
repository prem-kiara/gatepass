'use strict';

/**
 * Generates a VAPID keypair for Web Push and prints the two .env lines.
 *
 * Run once per environment. Rotating the keys invalidates every existing device
 * subscription — users would have to re-enable notifications — so keep the pair
 * stable once devices are subscribed.
 */

const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('# Add these to .env, then restart the app.');
console.log('# The private key is a secret; the public key is served to browsers.');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
