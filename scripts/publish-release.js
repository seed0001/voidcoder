// Builds the Windows installer and publishes it to GitHub Releases —
// WITHOUT electron-builder's own `--publish always` flag.
//
// Why: electron-builder's built-in GitHub publisher has a real, repeatedly-
// observed race in this project. When it uploads multiple artifacts to a
// release that doesn't exist yet, more than one upload lazily tries to
// create the release at once; one wins, the other gets a 422
// "already_exists" from GitHub, and electron-builder aborts the REST of
// the publish step — including regenerating latest.yml and uploading the
// .exe — leaving only whatever partial upload already finished (usually
// just the .exe.blockmap) sitting on an otherwise-empty release. This has
// hit three releases in a row (v0.2.2, v0.2.3, v0.2.4), each requiring a
// manual fix afterward: hand-verify what actually made it up, recompute a
// correct latest.yml (the stale one left behind literally described the
// PREVIOUS version — shipping it would have broken the auto-updater), and
// re-upload via `gh release upload`.
//
// This script does that same reliable sequence directly instead of fighting
// electron-builder's publisher: build locally only (`--publish never`, so
// electron-builder never touches the GitHub API at all), compute a correct
// latest.yml ourselves from the actual built file, then create/upload via
// a single well-understood `gh` CLI call — no race, because nothing here
// is racing itself.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// No shell by default: git.exe and gh.exe are real Windows executables, and
// running them through a shell needlessly risks the shell re-splitting any
// argument that happens to contain a space (hit exactly this: an unquoted
// multi-word --notes value got tokenized into extra bare args, one of which
// gh then tried to glob-match as an asset filename and failed). npx IS a
// .cmd shim on Windows though — execFileSync can't spawn that directly
// without a shell (the ENOENT the very first run hit) — so it opts in below.
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const exeName = `VoidCode-Setup-${version}.exe`;
  const exePath = path.join(DIST, exeName);
  const blockmapPath = `${exePath}.blockmap`;
  const latestYmlPath = path.join(DIST, 'latest.yml');

  console.log(`\n== Releasing ${tag} ==\n`);

  // Fail fast rather than silently tagging on someone's behalf — tagging is
  // a release decision, made explicitly with git, before this script runs.
  try {
    runCapture('git', ['rev-parse', tag]);
  } catch {
    console.error(`\n✗ Tag ${tag} does not exist yet. Create and push it first:\n\n    git tag ${tag}\n    git push origin ${tag}\n`);
    process.exit(1);
  }

  console.log('-- Building (local only — electron-builder never touches the GitHub API) --');
  run('npx', ['electron-builder', '--publish', 'never'], { shell: true });

  if (!fs.existsSync(exePath)) {
    console.error(`\n✗ Expected build output not found: ${exePath}`);
    process.exit(1);
  }
  // Only generated when nsis.differentialPackage is enabled — this project
  // disabled it (see "Re-disable differential updates ...") so every update
  // ships as a full file instead of a binary diff. No blockmap means
  // nothing to upload or verify.
  const hasBlockmap = fs.existsSync(blockmapPath);

  console.log('\n-- Computing latest.yml from the actual built file --');
  const stat = fs.statSync(exePath);
  const sha512 = sha512Base64(exePath);
  const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${exeName}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${exeName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  fs.writeFileSync(latestYmlPath, yml);
  console.log(yml);

  console.log('-- Publishing to GitHub Releases --');
  let releaseExists = true;
  try {
    runCapture('gh', ['release', 'view', tag, '--repo', 'seed0001/voidcoder']);
  } catch {
    releaseExists = false;
  }
  if (!releaseExists) {
    run('gh', ['release', 'create', tag, '--repo', 'seed0001/voidcoder', '--title', version, '--notes', `VoidCode ${version}`]);
  }
  // --clobber: safe to re-run this script after a partial failure without
  // manually figuring out what already made it up.
  const uploadPaths = hasBlockmap ? [exePath, blockmapPath, latestYmlPath] : [exePath, latestYmlPath];
  run('gh', ['release', 'upload', tag, ...uploadPaths, '--repo', 'seed0001/voidcoder', '--clobber']);

  console.log('\n-- Verifying the published latest.yml actually describes this version --');
  const published = runCapture('gh', ['release', 'view', tag, '--repo', 'seed0001/voidcoder', '--json', 'assets', '-q', '.assets[].name']);
  const assetNames = published.trim().split('\n');
  const requiredAssets = hasBlockmap ? [exeName, `${exeName}.blockmap`, 'latest.yml'] : [exeName, 'latest.yml'];
  for (const required of requiredAssets) {
    if (!assetNames.includes(required)) {
      console.error(`\n✗ ${required} is missing from the published release — something is still wrong.`);
      process.exit(1);
    }
  }
  console.log(`\n✓ ${tag} published with all ${requiredAssets.length} assets verified present: ${requiredAssets.join(', ')}`);
  console.log(`  https://github.com/seed0001/voidcoder/releases/tag/${tag}\n`);
}

main();
