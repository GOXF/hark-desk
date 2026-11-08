// Hark 账号窗口的主 WebView 入口：只渲染顶部账号切换条，
// 下方的 hark.com 子 WebView 由 Rust（src-tauri/src/hark_window.rs）叠放。
import { ThemeProvider } from '@/components/ThemeProvider';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { useUserSystem } from '@/components/ConfigProvider';
import { HarkWindowBar } from '@/features/hark-accounts/HarkWindowBar';
import { ThemeMode } from 'shared/types';

export function HarkWindowApp() {
  const { config } = useUserSystem();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <LegacyDesignScope>
        <HarkWindowBar />
      </LegacyDesignScope>
    </ThemeProvider>
  );
}
