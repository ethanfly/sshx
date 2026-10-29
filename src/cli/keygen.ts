import path from 'node:path';
import os from 'node:os';
import { KeyManager } from '../core/keygen.js';
import { colors, prompt } from './utils.js';

export interface KeygenCliOptions {
  type?: 'ed25519' | 'rsa';
  bits?: string | number;
  file?: string;
  comment?: string;
  passphrase?: string;
}

export async function runKeygen(options: KeygenCliOptions = {}): Promise<void> {
  const type = options.type || 'ed25519';
  const bits = options.bits ? Number(options.bits) : (type === 'rsa' ? 3072 : undefined);

  let filePath = options.file;
  if (!filePath) {
    const defaultPath = path.join(os.homedir(), '.sshx', 'keys', `id_${type}`);
    const inputPath = await prompt(`${colors.bold}Enter file in which to save the key (${defaultPath}):${colors.reset} `);
    filePath = inputPath || defaultPath;
  }

  let passphrase = options.passphrase;
  if (passphrase === undefined) {
    const p1 = await prompt(`${colors.bold}Enter passphrase (empty for no passphrase):${colors.reset} `, true);
    if (p1) {
      const p2 = await prompt(`${colors.bold}Enter same passphrase again:${colors.reset} `, true);
      if (p1 !== p2) {
        process.stderr.write(`${colors.red}Passphrases do not match.${colors.reset}\n`);
        process.exit(1);
      }
      passphrase = p1;
    }
  }

  const comment = options.comment || `${os.userInfo().username}@${os.hostname()}`;

  process.stdout.write(`Generating public/private ${type} key pair...\n`);
  const result = KeyManager.saveKeyPairToDisk(filePath, {
    type,
    bits,
    comment,
    passphrase: passphrase || undefined
  });

  process.stdout.write(`${colors.green}Your identification has been saved in ${result.privateKeyPath}${colors.reset}\n`);
  process.stdout.write(`${colors.green}Your public key has been saved in ${result.publicKeyPath}${colors.reset}\n`);
  process.stdout.write(`The key fingerprint is:\n${colors.bold}${result.fingerprintSha256}${colors.reset} ${comment}\n`);
}
