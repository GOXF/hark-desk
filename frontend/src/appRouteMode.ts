// 'hark-window'：Hark 账号窗口的主 WebView，只渲染顶部账号切换条。
export type AppRouteMode = 'desktop-toast' | 'hark-window' | 'main';

export function getAppRouteMode(pathname: string): AppRouteMode {
  if (pathname === '/desktop-toast') return 'desktop-toast';
  if (pathname === '/hark-window') return 'hark-window';
  return 'main';
}
