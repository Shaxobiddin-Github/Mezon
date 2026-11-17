import { create } from 'zustand';
import { type AdminUser, adminApi } from '../api-client.js';

interface AuthState {
  user: AdminUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (login, password) => {
    const res = await adminApi.login({ login, password });
    set({
      user: res.user,
      isAuthenticated: true,
      isLoading: false,
    });
  },

  logout: async () => {
    await adminApi.logout();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  checkSession: async () => {
    try {
      const refreshed = await adminApi.refresh();
      adminApi.setAccessToken(refreshed.accessToken);
      // To get user info, we can make a lightweight dashboard query
      set({ isAuthenticated: true, isLoading: false });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));

adminApi.setOnUnauthorized(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
});
