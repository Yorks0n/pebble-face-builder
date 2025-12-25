import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function findPbw(root: string): Promise<string | null> {
  const buildDir = path.join(root, 'build');
  try {
    const entries = await fs.readdir(buildDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.pbw')) {
        return path.join(buildDir, entry.name);
      }
    }
  } catch {
    // Ignore and fallback to recursive scan.
  }

  const queue: string[] = [root];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.pbw')) {
        return fullPath;
      }
    }
  }

  return null;
}
