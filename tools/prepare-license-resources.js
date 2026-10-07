// electron-builder beforePack hook: retain readable upstream notices outside ASAR.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const destination = path.join(root, 'build', 'third-party-licenses');

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target); // Missing required notices must fail packaging.
}

function prepareLicenseResources() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const inventory = [];
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath || entry.dev) continue;
    const directory = path.join(root, packagePath);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (metadata.version !== entry.version) {
      throw new Error(`License inventory version mismatch for ${packagePath}; run npm ci.`);
    }
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(file => file.isFile() && /^(licen[cs]e|copying|notice|copyright|readme)([._-]|$)/i.test(file.name))
      .map(file => file.name).sort();
    const hasLicenseFile = files.some(file => /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(file));
    const hasReadmeLicense = files.some(file => /^readme([._-]|$)/i.test(file)
      && /permission is hereby granted|redistribution and use|licensed under/i.test(fs.readFileSync(path.join(directory, file), 'utf8')));
    if (!hasLicenseFile && !hasReadmeLicense) {
      if (metadata.name !== 'lazy-val' || metadata.version !== '1.0.5' || metadata.license !== 'MIT') {
        throw new Error(`No upstream license or notice found for ${packagePath}.`);
      }
      for (const file of ['LICENSE', 'NOTICE']) {
        copyFile(path.join(root, 'resources', 'licenses', 'lazy-val', file), path.join(destination, 'npm', packagePath, file));
      }
      copyFile(path.join(directory, 'package.json'), path.join(destination, 'npm', packagePath, 'package.json'));
    }
    for (const file of files) {
      copyFile(path.join(directory, file), path.join(destination, 'npm', packagePath, file));
    }
    inventory.push({
      name: metadata.name,
      version: metadata.version,
      packagePath,
      license: metadata.license || metadata.licenses || entry.license || 'See component license files',
      files,
    });
  }

  const electronDirectory = path.join(root, 'node_modules', 'electron', 'dist');
  for (const file of ['LICENSE', 'LICENSES.chromium.html', 'version']) {
    copyFile(path.join(electronDirectory, file), path.join(destination, 'electron', file));
  }
  for (const file of ['ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) {
    copyFile(path.join(root, 'node_modules', 'ffmpeg-static', file), path.join(destination, 'ffmpeg', file));
  }
  for (const file of ['LICENSE', 'PROVENANCE.md']) {
    copyFile(path.join(root, 'resources', 'licenses', 'cloudflared', file), path.join(destination, 'cloudflared', file));
  }
  fs.writeFileSync(path.join(destination, 'npm-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  console.log(`[DubLine] Prepared license notices for ${inventory.length} npm packages and bundled runtimes.`);
}

module.exports = prepareLicenseResources;
if (require.main === module) prepareLicenseResources();
