const API_URL = ''; // Uses proxy in dev, same origin in prod

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function fetchWithAuth(path: string, options: RequestInit = {}, skipAuthRedirect = false) {
  const token = localStorage.getItem('token');
  
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        errorMessage = error.error || errorMessage;
      } else {
        const text = await response.text();
        errorMessage = text.substring(0, 200) || errorMessage;
      }
    } catch {
      // parsing failed, use default
    }
    // Only redirect on 401 if we had a token (i.e., session expired)
    // Don't redirect for login failures
    if (response.status === 401 && token && !skipAuthRedirect) {
      localStorage.removeItem('token');
      window.location.reload();
    }
    throw new ApiError(response.status, errorMessage);
  }

  return response.json();
}

export interface User {
  id: number
  username: string
  public_key: string
  created_at: string
  last_seen: string
  online: boolean
}

export interface Message {
  id: number
  sender_id: number
  receiver_id: number
  type: 'text' | 'file' | 'call'
  content: string  // base64 encoded encrypted content
  nonce: string    // base64 encoded nonce
  timestamp: string
  read: boolean
}

export const api = {
  // Auth
  register: (username: string, password: string, inviteCode: string, publicKey: string) =>
    fetchWithAuth('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, invite_code: inviteCode, public_key: publicKey }),
    }),

  login: (username: string, password: string) =>
    fetchWithAuth('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }, true), // skip auth redirect on 401

  validateInvite: (code: string) =>
    fetchWithAuth('/api/invite/validate', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  // Users
  getUsers: (): Promise<User[]> =>
    fetchWithAuth('/api/users'),

  getMe: (): Promise<User> =>
    fetchWithAuth('/api/users/me'),

  updatePublicKey: (publicKey: string) =>
    fetchWithAuth('/api/users/update-key', {
      method: 'POST',
      body: JSON.stringify({ public_key: publicKey }),
    }),

  // Messages
  getMessages: (userId: number): Promise<Message[]> =>
    fetchWithAuth(`/api/messages/${userId}`),

  sendMessage: (receiverId: number, content: string, nonce: string, type: string = 'text') =>
    fetchWithAuth('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ receiver_id: receiverId, type, content, nonce }),
    }),

  // Invites (admin)
  createInvite: (): Promise<{ code: string }> =>
    fetchWithAuth('/api/invites', {
      method: 'POST',
    }),
};

export default api;
