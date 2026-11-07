// Hark 本地文件桥：前后端共用的类型（与 src-tauri/src/hark_bridge/types.rs 一一对应）。
// 完整契约见 /workspace/work/hark-bridge-contract.md。状态里绝不包含文件桥密钥和 ngrok authtoken 明文。

/** 通道模式：ngrok 固定地址 / 自己的域名 / Cloudflare 临时地址。三种都保留。 */
export type HarkBridgeTunnelMode = 'ngrok' | 'custom' | 'cloudflare';

/** 桥的运行状态。 */
export type HarkBridgeStatus = 'stopped' | 'starting' | 'running' | 'no-tunnel' | 'error';

/** 执行命令模式：关闭 / 每条需确认 / 自动执行。 */
export type HarkBridgeExecMode = 'off' | 'confirm' | 'auto';

/** 命令审批回复：这一次允许 / 一直允许（执行模式改 auto）/ 这一次拒绝 / 拒绝并关闭（执行模式改 off）。 */
export type HarkBridgeConfirmAnswer = 'allow' | 'always' | 'deny' | 'never';

export interface HarkBridgeTunnelState {
  mode: HarkBridgeTunnelMode;
  /** ngrok 固定域名（不带 https:// 和 /mcp），可能为空 */
  ngrokDomain: string;
  hasNgrokToken: boolean;
  /** 自己的域名（根地址，不带 /mcp），可能为空 */
  customUrl: string;
  /** 主桥是否走全局代理 */
  useProxy: boolean;
  /** 主桥状态 */
  status: HarkBridgeStatus;
  /** 主桥对外地址（以 /mcp 结尾；没上线为空串） */
  url: string;
  fixed: boolean;
  port: number;
  /** 错误/提示文字，空串表示没有 */
  err: string;
  /** HarkBridge 实际使用的通道：'ngrok' | 'cloudflare-fallback' | 'custom' | '' */
  tunnel: string;
}

export interface HarkBridgeItem {
  id: string;
  name: string;
  folder: string;
  readonly: boolean;
  allowDelete: boolean;
  execMode: HarkBridgeExecMode;
  /** 子桥自己的地址（根地址）；空串 = 经主桥 /mcp/<id> 转发。主桥恒为空串 */
  publicUrl: string;
  status: HarkBridgeStatus;
  /** 地址可用且密钥已就绪，可以发连接消息 */
  online: boolean;
  /** 对外地址（以 /mcp 或 /mcp/<id> 结尾；不在线为空串） */
  url: string;
  port: number;
  err: string;
  isMain: boolean;
  /** 用户手动停止（启动应用时不自动启动） */
  stopped: boolean;
  /** 地址是否固定（重启不变） */
  fixed: boolean;
}

export interface HarkBridgeBinding {
  profileId: string;
  bridgeId: string;
  /** 连接消息发到的项目链接；空串 = 当前聊天 */
  projectUrl: string;
  /** 上次成功发给这个账号的地址 */
  sentUrl: string | null;
  sending: boolean;
  /** 最近一次发送失败的原因 */
  sendErr: string | null;
}

export interface HarkBridgeConfirm {
  bridgeId: string;
  reqId: string;
  kind: string;
  command: string;
  cwd: string;
}

export interface HarkBridgeState {
  tunnel: HarkBridgeTunnelState;
  bridges: HarkBridgeItem[];
  defaultBridge: string;
  bindings: HarkBridgeBinding[];
  /** 等待审批的命令执行请求 */
  confirms: HarkBridgeConfirm[];
  /** 安装包里是否找到了 HarkBridge 程序 */
  bridgeExeFound: boolean;
}

/** hark_bridge_tunnel_save 的参数。 */
export interface HarkBridgeTunnelSaveArgs {
  mode: HarkBridgeTunnelMode;
  /** 传了就更新（空串 = 清除） */
  ngrokDomain?: string;
  /** 非空才更新 */
  ngrokToken?: string;
  clearToken?: boolean;
  /** 传了就更新；mode=custom 时最终必须非空 */
  customUrl?: string;
  useProxy?: boolean;
}

/** hark_bridge_update 的 patch（只改传了的字段）。 */
export interface HarkBridgePatch {
  name?: string;
  folder?: string;
  readonly?: boolean;
  allowDelete?: boolean;
  execMode?: HarkBridgeExecMode;
  /** 子桥自己的地址；空串清除。主桥传非空会报错 */
  publicUrl?: string;
  /** 本机端口；0 = 自动 */
  port?: number;
}

/** 后端推送的事件名。 */
export const HARK_BRIDGE_STATE_EVENT = 'hark-bridge://state';
export const HARK_BRIDGE_CONFIRM_EVENT = 'hark-bridge://confirm';

/** Tauri 命令名。 */
export const HARK_BRIDGE_COMMANDS = {
  state: 'hark_bridge_state',
  tunnelSave: 'hark_bridge_tunnel_save',
  create: 'hark_bridge_create',
  update: 'hark_bridge_update',
  delete: 'hark_bridge_delete',
  start: 'hark_bridge_start',
  stop: 'hark_bridge_stop',
  setDefault: 'hark_bridge_set_default',
  bind: 'hark_bridge_bind',
  unbind: 'hark_bridge_unbind',
  connectMessage: 'hark_bridge_connect_message',
  send: 'hark_bridge_send',
  confirm: 'hark_bridge_confirm',
  logs: 'hark_bridge_logs',
} as const;
