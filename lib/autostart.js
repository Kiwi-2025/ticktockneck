const path = require('path');

// 便携版（electron-builder 的 portable 目标）不是"就地运行"的：引导程序每次启动
// 都会把整个程序解包到 %TEMP%\ 下的一个随机目录，再运行解包出来的 exe，退出时
// 再把这个目录删掉。也就是说 process.execPath 指向的是**临时副本**，而不是用户
// 双击的那个便携 exe。
//
// 于是 app.setLoginItemSettings()（默认用 process.execPath）会把登录项写成
//   C:\Users\<user>\AppData\Local\Temp\<随机>\ticktockneck.exe --hidden
// 下一次开机 Windows 就会去启动那个临时副本。可那个目录在退出时就被删了，
// 只剩下删不掉的残骸（exe、dll、app.asar 还在，Chromium 的 resources.pak /
// chrome_100_percent.pak 等资源包已经没了）。程序能起来、托盘也在，但渲染进程
// 加载不到资源、画不出首帧 —— 窗口一直是"看不见"的；这时再点托盘，就会把一个
// 从没绘制过的窗口 show 出来，用户看到的就是"窗口打开了，里面什么都没有"。
//
// 所以登录项必须指向**稳定的可执行文件路径**：优先用引导程序设置的
// PORTABLE_EXECUTABLE_FILE（用户双击的那个便携 exe），其次用上次记住的路径，
// 最后才是 process.execPath —— 且必须排除临时目录。

function normalize(p) {
  if (!p) return '';
  // path.resolve 统一分隔符、去掉尾部多余的 \ 或 /；Windows 路径大小写不敏感。
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

// 路径是否落在系统临时目录里。tmpDir 由调用方传入（主进程传 app.getPath('temp')），
// 测试里可以传一个假目录，不必依赖运行环境的 %TEMP%。
function isTempPath(p, tmpDir) {
  const target = normalize(p);
  const tmp = normalize(tmpDir);
  if (!target || !tmp) return false;
  if (target === tmp) return true;
  // 必须按目录边界比较：C:\Temp\foo 是临时路径，C:\TempFiles\foo 不是。
  return target.startsWith(tmp.endsWith(path.sep) ? tmp : tmp + path.sep);
}

// 计算开机自启应该注册的可执行文件路径。返回 null 表示"没有可用的稳定路径"，
// 调用方应当不注册（并清掉旧条目），而不是把临时副本写进登录项。
function resolveAutostartPath({ execPath, portableExeFile, rememberedPath, tmpDir } = {}) {
  const candidates = [portableExeFile, rememberedPath, execPath];
  for (const candidate of candidates) {
    if (candidate && !isTempPath(candidate, tmpDir)) return candidate;
  }
  return null;
}

// 解析 `reg query HKCU\...\Run` 的输出：
//     electron.app.ticktockneck    REG_SZ    C:\Apps\ticktockneck.exe --hidden
// 值名里可能有空格（CC Switch），所以按"两个以上空格 + REG_ 类型"切分。
function parseRunKeyEntries(output) {
  const entries = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}REG_\w+\s{2,}(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ name: match[1].trim(), command: match[2].trim() });
  }
  return entries;
}

// 从一条启动命令行里取出可执行文件路径。路径可能带引号，也可能不带
// （Electron 写入登录项时不加引号，便携版路径里还常常带空格）。
function commandExecutable(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    return end > 0 ? cmd.slice(1, end) : '';
  }
  const match = /^(.+?\.exe)(?:\s|$)/i.exec(cmd);
  return match ? match[1] : cmd.split(/\s+/)[0];
}

// 找出必须删掉的登录项：命令行指向临时目录、且 exe 名字和我们自己一样。
// 只删自己的条目——别的程序把启动项放临时目录里不关我们的事。
function staleLoginItemNames(entries, { tmpDir, exeName } = {}) {
  const wanted = String(exeName || '').toLowerCase();
  return (entries || [])
    .filter((entry) => {
      const exe = commandExecutable(entry.command);
      if (!exe || !isTempPath(exe, tmpDir)) return false;
      return !wanted || path.basename(exe).toLowerCase() === wanted;
    })
    .map((entry) => entry.name);
}

module.exports = {
  isTempPath,
  resolveAutostartPath,
  parseRunKeyEntries,
  commandExecutable,
  staleLoginItemNames,
};
