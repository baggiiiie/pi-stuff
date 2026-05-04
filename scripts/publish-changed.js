#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(rootDir);

loadDotEnv();

const bumpType = process.argv[2] ?? 'patch';
const publishArgs = process.argv.slice(3);
const validBumps = new Set(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease']);
const dryRun = publishArgs.includes('--dry-run');
const tagFile = join(rootDir, '.publish-tags');

if (!validBumps.has(bumpType)) {
  console.error('Usage: npm run publish:changed -- [patch|minor|major|prepatch|preminor|premajor|prerelease] [npm publish args...]');
  process.exit(1);
}
if (!publishArgs.includes('--access')) publishArgs.unshift('--access', 'public');
if (existsSync(tagFile)) rmSync(tagFile);

if (process.env.NPM_TOKEN) console.log('Using NPM_TOKEN for non-interactive npm auth');
else console.error('Warning: NPM_TOKEN is not set. For CI, add repo secret NPM_TOKEN.');

function loadDotEnv() {
  const path = join(rootDir, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return result.status === 0 ? result.stdout.trim() : '';
}
function readPackage(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function compareVersions(a, b) {
  const parse = (version) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parse(a), right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0, y = right[i] ?? 0;
    if (typeof x === typeof y) { if (x > y) return 1; if (x < y) return -1; }
    else return typeof x === 'number' ? 1 : -1;
  }
  return 0;
}
function tagPrefix(pkgName) {
  return `pkg/${pkgName}/v`;
}
function latestPackageTag(pkgName) {
  const tags = output('git', ['tag', '--list', `${tagPrefix(pkgName)}*`, '--sort=-v:refname']);
  return tags.split('\n').filter(Boolean)[0] ?? '';
}
function hasChangesSince(ref, dir) {
  const result = spawnSync('git', ['diff', '--quiet', `${ref}..HEAD`, '--', relative(rootDir, dir)], { shell: false });
  return result.status === 1;
}
function packageDirs() {
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .sort();
}

let updated = false;
const publishedTags = [];

for (const dir of packageDirs()) {
  const packageJson = join(dir, 'package.json');
  if (!existsSync(packageJson)) continue;

  let pkg = readPackage(packageJson);
  if (pkg.private) {
    console.log(`Skipping ${pkg.name} (private)`);
    continue;
  }

  const latestTag = latestPackageTag(pkg.name);
  const publishedVersion = output('npm', ['view', pkg.name, 'version']);
  const changed = latestTag ? hasChangesSince(latestTag, dir) : true;

  if (!changed) {
    console.log(`Skipping ${pkg.name} (no changes since ${latestTag})`);
    continue;
  }

  if (publishedVersion && pkg.version === publishedVersion) {
    console.log(`==> Bumping ${pkg.name} (${pkg.version} -> ${bumpType})`);
    run('npm', ['version', bumpType, '--no-git-tag-version'], { cwd: dir });
    updated = true;
    pkg = readPackage(packageJson);
  } else if (publishedVersion && compareVersions(pkg.version, publishedVersion) < 0) {
    console.error(`ERROR: ${pkg.name} local version ${pkg.version} is older than npm ${publishedVersion}`);
    process.exit(1);
  } else if (!publishedVersion) {
    console.log(`==> ${pkg.name} is not published yet; publishing ${pkg.version}`);
  } else {
    console.log(`==> ${pkg.name} local version ${pkg.version} is already newer than npm ${publishedVersion}`);
  }

  console.log(`==> Publishing ${pkg.name} from ${relative(rootDir, dir)}`);
  run('npm', ['publish', ...publishArgs], { cwd: dir });
  if (!dryRun) publishedTags.push(`${tagPrefix(pkg.name)}${pkg.version}`);
  console.log('');
}

if (updated) run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
if (publishedTags.length) writeFileSync(tagFile, `${publishedTags.join('\n')}\n`);
console.log(publishedTags.length ? `Wrote ${relative(rootDir, tagFile)}` : 'No packages published.');
