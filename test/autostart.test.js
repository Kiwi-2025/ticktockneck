const test = require('node:test');
const assert = require('node:assert');
const {
  isTempPath,
  resolveAutostartPath,
  parseRunKeyEntries,
  commandExecutable,
  staleLoginItemNames,
} = require('../lib/autostart.js');

const TEMP = 'C:\\Users\\ROG\\AppData\\Local\\Temp';
const PORTABLE = 'D:\\Tools\\ticktockneck 1.2.1.exe';

test('paths under the temp dir are temp paths, sibling dirs are not', () => {
  assert.strictEqual(isTempPath(`${TEMP}\\3KwrfGCPgTnLR90INau8JJKcBW7\\ticktockneck.exe`, TEMP), true);
  assert.strictEqual(isTempPath(`${TEMP}\\ticktockneck.exe`, TEMP), true);
  // 目录边界：前缀相同但不是子目录
  assert.strictEqual(isTempPath('C:\\Users\\ROG\\AppData\\Local\\TempFiles\\a.exe', TEMP), false);
  assert.strictEqual(isTempPath(PORTABLE, TEMP), false);
});

test('temp path matching ignores case and trailing separators', () => {
  assert.strictEqual(isTempPath('c:\\users\\rog\\appdata\\local\\temp\\x\\a.exe', TEMP), true);
  assert.strictEqual(isTempPath(PORTABLE, `${TEMP}\\`), false);
  assert.strictEqual(isTempPath(`${TEMP}\\`, TEMP), true);
});

test('missing inputs never look like temp paths', () => {
  assert.strictEqual(isTempPath('', TEMP), false);
  assert.strictEqual(isTempPath(null, TEMP), false);
  assert.strictEqual(isTempPath(PORTABLE, ''), false);
});

test('portable launcher path wins over the temp copy', () => {
  const resolved = resolveAutostartPath({
    execPath: `${TEMP}\\3KwrfGCPgTnLR90INau8JJKcBW7\\ticktockneck.exe`,
    portableExeFile: PORTABLE,
    tmpDir: TEMP,
  });
  assert.strictEqual(resolved, PORTABLE);
});

test('remembered portable path is used when the app runs from a temp copy', () => {
  const resolved = resolveAutostartPath({
    execPath: `${TEMP}\\stale-copy\\ticktockneck.exe`,
    rememberedPath: PORTABLE,
    tmpDir: TEMP,
  });
  assert.strictEqual(resolved, PORTABLE);
});

test('an installed (non-temp) exe is registered as is', () => {
  const installed = 'C:\\Users\\ROG\\AppData\\Local\\Programs\\ticktockneck\\ticktockneck.exe';
  assert.strictEqual(resolveAutostartPath({ execPath: installed, tmpDir: TEMP }), installed);
});

test('there is no stable target when every candidate is a temp copy', () => {
  assert.strictEqual(resolveAutostartPath({
    execPath: `${TEMP}\\stale-copy\\ticktockneck.exe`,
    rememberedPath: `${TEMP}\\older-copy\\ticktockneck.exe`,
    tmpDir: TEMP,
  }), null);
  assert.strictEqual(resolveAutostartPath({ tmpDir: TEMP }), null);
});

const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  '    ctfmon    REG_SZ    C:\\Windows\\system32\\ctfmon.exe',
  '    Steam    REG_SZ    "D:\\Steam\\steam.exe" -silent',
  '    CC Switch    REG_SZ    D:\\CC_Switch\\cc-switch.exe ',
  '    electron.app.ticktockneck    REG_SZ    C:\\Users\\ROG\\AppData\\Local\\Temp\\3Kwrf\\ticktockneck.exe --hidden',
  '',
].join('\r\n');

test('reg query output is parsed into name/command pairs', () => {
  assert.deepStrictEqual(parseRunKeyEntries(REG_OUTPUT), [
    { name: 'ctfmon', command: 'C:\\Windows\\system32\\ctfmon.exe' },
    { name: 'Steam', command: '"D:\\Steam\\steam.exe" -silent' },
    { name: 'CC Switch', command: 'D:\\CC_Switch\\cc-switch.exe' },
    {
      name: 'electron.app.ticktockneck',
      command: 'C:\\Users\\ROG\\AppData\\Local\\Temp\\3Kwrf\\ticktockneck.exe --hidden',
    },
  ]);
  assert.deepStrictEqual(parseRunKeyEntries(''), []);
  assert.deepStrictEqual(parseRunKeyEntries(undefined), []);
});

test('executable is extracted with and without quotes', () => {
  assert.strictEqual(commandExecutable('"D:\\Steam\\steam.exe" -silent'), 'D:\\Steam\\steam.exe');
  assert.strictEqual(commandExecutable('C:\\Windows\\system32\\ctfmon.exe'), 'C:\\Windows\\system32\\ctfmon.exe');
  // 便携版路径带空格且没加引号（Electron 就是这样写的）
  assert.strictEqual(
    commandExecutable('D:\\Tools\\ticktockneck 1.2.1.exe --hidden'),
    'D:\\Tools\\ticktockneck 1.2.1.exe');
  assert.strictEqual(commandExecutable(''), '');
});

test('only temp-dir login items belonging to this app are stale', () => {
  const names = staleLoginItemNames(parseRunKeyEntries(REG_OUTPUT), {
    tmpDir: TEMP,
    exeName: 'ticktockneck.exe',
  });
  assert.deepStrictEqual(names, ['electron.app.ticktockneck']);
});

test('login items of other programs, or of this app at a stable path, are kept', () => {
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '    other-app    REG_SZ    C:\\Users\\ROG\\AppData\\Local\\Temp\\somewhere\\other.exe',
    '    electron.app.ticktockneck    REG_SZ    D:\\Tools\\ticktockneck 1.2.1.exe --hidden',
  ].join('\r\n');
  assert.deepStrictEqual(staleLoginItemNames(parseRunKeyEntries(output), {
    tmpDir: TEMP,
    exeName: 'ticktockneck.exe',
  }), []);
});
