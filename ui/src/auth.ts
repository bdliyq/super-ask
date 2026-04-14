let _authToken = "";

/** 在渲染前调用，从 /api/auth-token 拉取 token */
export async function initAuthToken(): Promise<void> {
  try {
    const res = await fetch("/api/auth-token");
    const data = (await res.json()) as { token?: string };
    _authToken = data.token ?? "";
  } catch {
    _authToken = "";
  }
}

export function getAuthToken(): string {
  return _authToken;
}

export function getAuthHeaders(): Record<string, string> {
  return _authToken ? { Authorization: `Bearer ${_authToken}` } : {};
}

export function withAuthHeaders(
  headers?: Record<string, string>,
): Record<string, string> {
  return { ...getAuthHeaders(), ...headers };
}
