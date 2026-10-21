import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
const assets = JSON.parse(await readFile(new URL('../src/app/canvas-pdf/font-assets.json', import.meta.url), 'utf8'));
// Imported by src/app/canvas-pdf/font-urls.ts, so each build names the files by content (2.1-M176).
const root = new URL('../src/app/canvas-pdf/fonts/', import.meta.url);
await mkdir(root, { recursive: true });
for (const asset of assets) {
  const target = new URL(asset.file, root);
  let data;
  try { data = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!data || createHash('sha256').update(data).digest('hex') !== asset.sha256) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Cannot fetch PDF font ${asset.id}: HTTP ${response.status}`);
    data = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error(`PDF font integrity failed: ${asset.id}`);
    const temporary = new URL(`${asset.file}.${process.pid}.tmp`, root);
    try { await writeFile(temporary, data); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  const licenseTarget = new URL(`${asset.id}-LICENSE.txt`, root);
  try { await readFile(licenseTarget); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(asset.license, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot fetch PDF font license ${asset.id}`);
    await writeFile(licenseTarget, await response.text());
  }
  console.log(`Verified PDF font ${asset.id}: ${data.length} bytes`);
}
