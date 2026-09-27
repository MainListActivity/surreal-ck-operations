import { readFile, stat } from 'node:fs/promises';

export async function readPrivateCredential(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('credential file must be a regular file accessible only to its owner');
  }
  const credential = (await readFile(path, 'utf8')).trim();
  if (!credential.startsWith('sck_') || credential.length > 200) throw new Error('invalid credential file');
  return credential;
}
