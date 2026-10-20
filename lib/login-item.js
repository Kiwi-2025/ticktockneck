// 计算系统登录项（开机自启）应该带的启动参数。
// - autoStart 关闭时不注册，返回空数组；
// - autoStart 打开、silentStart 关闭时正常注册，开机弹出主窗口；
// - silentStart 打开时带 --hidden，开机只驻留托盘、不弹主窗口。
function loginItemArgs({ autoStart, silentStart }) {
  if (!autoStart) return [];
  return silentStart ? ['--hidden'] : [];
}

module.exports = { loginItemArgs };
