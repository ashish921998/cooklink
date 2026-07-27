import { PROVIDER_SECRET_PATTERN } from './provider-secrets.js';

const publicEnv = Object.entries(process.env).filter(([key]) => key.startsWith('EXPO_PUBLIC_'));
const leaked = publicEnv.filter(([key]) => PROVIDER_SECRET_PATTERN.test(key));

if (leaked.length > 0) {
  console.error(
    `Server-only secret names are present in public Expo env: ${leaked.map(([key]) => key).join(', ')}`,
  );
  process.exit(1);
}

console.log('No server-only secret names found in EXPO_PUBLIC_* env.');
