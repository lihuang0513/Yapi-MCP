import WebSocket from "ws";

interface ChromeJsonTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ChromeCookie {
  name: string;
  value: string;
}

interface CdpResponse<T = any> {
  id?: number;
  result?: T;
  error?: {
    message?: string;
  };
}

const DEFAULT_DEBUG_URL = "http://127.0.0.1:9222";

function getDebugBaseUrl(): string {
  return (process.env.YAPI_MOCK_BROWSER_DEBUG_URL || DEFAULT_DEBUG_URL).replace(/\/+$/, "");
}

function isBrowserCookieEnabled(): boolean {
  const value = process.env.YAPI_MOCK_BROWSER_COOKIE;
  return value ? value !== "false" : true;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Chrome DevTools 请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function openPageTarget(debugBaseUrl: string, targetUrl: string): Promise<ChromeJsonTarget> {
  const response = await fetch(`${debugBaseUrl}/json/new?${encodeURIComponent(targetUrl)}`, {
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Chrome DevTools 新建页面失败: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ChromeJsonTarget>;
}

async function getPageWebSocketUrl(debugBaseUrl: string, targetUrl: string): Promise<string> {
  const targets = await fetchJson<ChromeJsonTarget[]>(`${debugBaseUrl}/json/list`);
  const target = targets.find(item => {
    return item.type === "page" && item.webSocketDebuggerUrl && item.url?.startsWith(targetUrl);
  }) || targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);

  if (target?.webSocketDebuggerUrl) {
    return target.webSocketDebuggerUrl;
  }

  const newTarget = await openPageTarget(debugBaseUrl, targetUrl);
  if (!newTarget.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools 未返回可用的 WebSocket 地址");
  }

  return newTarget.webSocketDebuggerUrl;
}

function createCdpClient(webSocketUrl: string) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  }>();

  socket.on("message", data => {
    const message = JSON.parse(String(data)) as CdpResponse;
    if (!message.id) {
      return;
    }

    const task = pending.get(message.id);
    if (!task) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      task.reject(new Error(message.error.message || "Chrome DevTools 调用失败"));
      return;
    }

    task.resolve(message.result);
  });

  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    async send<T = any>(method: string, params?: Record<string, any>): Promise<T> {
      await opened;
      const id = nextId++;
      const payload = JSON.stringify({ id, method, params: params || {} });
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(payload, error => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    close() {
      socket.close();
    }
  };
}

export async function getBrowserCookieHeader(targetUrl: string): Promise<string> {
  if (!isBrowserCookieEnabled()) {
    return "";
  }

  const debugBaseUrl = getDebugBaseUrl();
  const webSocketUrl = await getPageWebSocketUrl(debugBaseUrl, targetUrl);
  const cdp = createCdpClient(webSocketUrl);

  try {
    await cdp.send("Network.enable");
    const result = await cdp.send<{ cookies?: ChromeCookie[] }>("Network.getCookies", {
      urls: [targetUrl]
    });
    const cookies = result.cookies || [];
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  } finally {
    cdp.close();
  }
}

export function getBrowserCookieHelpText(): string {
  return [
    "自动读取浏览器 Cookie 失败。请确认 Chrome 已用远程调试端口启动：",
    "open -na \"Google Chrome\" --args --remote-debugging-port=9222",
    "如果使用自定义端口，可设置 YAPI_MOCK_BROWSER_DEBUG_URL=http://127.0.0.1:端口"
  ].join("\n");
}
