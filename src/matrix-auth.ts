/**
 * Matrix Authentication Script
 *
 * Run this during setup to authenticate with a Matrix homeserver.
 * Supports two modes:
 *   1. Password login — for accounts with a password
 *   2. Access token — for SSO accounts (Google, GitHub, etc.)
 *      Get your token from Element: Settings → Help & About → Access Token
 *
 * Usage: npx tsx src/matrix-auth.ts
 */
import fs from 'fs';
import readline from 'readline';

import { createClient } from 'matrix-js-sdk';

const AUTH_DIR = './store/matrix-auth';
const CREDENTIALS_FILE = `${AUTH_DIR}/credentials.json`;

function askQuestion(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function saveCredentials(creds: {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}): void {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));

  console.log('\n✓ Successfully configured Matrix!');
  console.log(`  User ID:  ${creds.userId}`);
  console.log(`  Device:   ${creds.deviceId}`);
  console.log(`  Saved to: ${CREDENTIALS_FILE}`);
  console.log('\n  Add these to your .env file:\n');
  console.log(`  MATRIX_HOMESERVER=${creds.homeserver}`);
  console.log(`  MATRIX_USER_ID=${creds.userId}`);
  console.log(`  MATRIX_ACCESS_TOKEN=${creds.accessToken}`);
  console.log('');
}

async function loginWithPassword(homeserver: string): Promise<void> {
  const username = await askQuestion('Username (e.g. mybot)');
  const password = await askQuestion('Password');

  if (!username || !password) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  console.log(`\nLogging in to ${homeserver} as ${username}...`);

  const client = createClient({ baseUrl: homeserver });

  try {
    const response = await client.login('m.login.password', {
      user: username,
      password,
      initial_device_display_name: 'NanoClaw Bot',
    });

    saveCredentials({
      homeserver,
      userId: response.user_id,
      accessToken: response.access_token,
      deviceId: response.device_id,
    });
  } catch (err: any) {
    const msg = err.data?.error || err.message || 'Unknown error';
    console.error(`\n✗ Login failed: ${msg}`);
    process.exit(1);
  } finally {
    client.stopClient();
  }
}

async function loginWithToken(homeserver: string): Promise<void> {
  console.log('\n  To get your access token from Element:');
  console.log('  1. Open Element (web or desktop)');
  console.log('  2. Go to Settings → Help & About');
  console.log('  3. Click to reveal "Access Token"');
  console.log('  4. Copy and paste it below\n');

  const accessToken = await askQuestion('Access token');
  if (!accessToken) {
    console.error('Access token is required.');
    process.exit(1);
  }

  console.log('\nVerifying token...');

  const client = createClient({ baseUrl: homeserver, accessToken });

  try {
    // Verify the token works by calling /whoami
    const whoami = await client.whoami();
    const userId = whoami.user_id;
    const deviceId = whoami.device_id || `NANOCLAW_${Date.now()}`;

    saveCredentials({
      homeserver,
      userId,
      accessToken,
      deviceId,
    });
  } catch (err: any) {
    const msg = err.data?.error || err.message || 'Unknown error';
    console.error(`\n✗ Token verification failed: ${msg}`);
    console.error('  Make sure you copied the full token.');
    process.exit(1);
  } finally {
    client.stopClient();
  }
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Check for existing credentials
  if (fs.existsSync(CREDENTIALS_FILE)) {
    console.log(`\n⚠  Credentials already exist at ${CREDENTIALS_FILE}`);
    const overwrite = await askQuestion('Overwrite? (y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  console.log('\n🔑 Matrix Authentication\n');

  const homeserver = await askQuestion('Homeserver URL', 'https://matrix.org');

  const method = await askQuestion(
    'Auth method — (1) password or (2) access token from Element?',
    '2',
  );

  if (method === '1' || method.toLowerCase().startsWith('p')) {
    await loginWithPassword(homeserver);
  } else {
    await loginWithToken(homeserver);
  }
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
