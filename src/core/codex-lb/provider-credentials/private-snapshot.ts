import fs from 'node:fs/promises';
import {
  PrivateCredentialFileError,
  readPrivateCredentialFile,
  writePrivateTextAtomic
} from '../../security/private-credential-file.js';

export type PrivateCredentialSnapshot = {
  readonly file: string;
  readonly label: string;
  readonly existed: boolean;
  readonly text: string;
};

export async function snapshotPrivateCredential(
  boundary: string,
  file: string,
  label: string
): Promise<PrivateCredentialSnapshot> {
  try {
    const snapshot = await readPrivateCredentialFile(boundary, file, label, { maxBytes: 1024 * 1024 });
    return { file, label, existed: true, text: snapshot.bytes.toString('utf8') };
  } catch (error) {
    if (error instanceof PrivateCredentialFileError && error.code === 'missing') {
      return { file, label, existed: false, text: '' };
    }
    throw error;
  }
}

export async function restorePrivateCredential(
  boundary: string,
  snapshot: PrivateCredentialSnapshot
): Promise<void> {
  if (snapshot.existed) {
    await writePrivateTextAtomic(boundary, snapshot.file, snapshot.text, snapshot.label);
    return;
  }
  const stat = await fs.lstat(snapshot.file).catch(() => null);
  if (!stat) return;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (expectedUid !== null && stat.uid !== expectedUid)) {
    throw new Error(`${snapshot.label}_rollback_target_invalid`);
  }
  await fs.unlink(snapshot.file);
}
