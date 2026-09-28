import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { AuthController, createAuthApi, resolveAuthConfig, type AuthConfig, type AuthState, type SessionStorage } from '../../lib/auth-core';

// Expo replaces these explicit references at build time. Neither variable is a secret.
const config = resolveAuthConfig(
  process.env.EXPO_PUBLIC_MOBILE_AUTH_ENABLED,
  process.env.EXPO_PUBLIC_MOBILE_AUTH_ORIGIN,
  Platform.OS,
);

function nativeStorage(configuration: AuthConfig): SessionStorage {
  // Namespace tokens by origin so changing staging/production never reuses another server's token.
  const key = configuration.enabled
    ? `swypik.auth.v1.${new URL(configuration.origin).host.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    : 'swypik.auth.disabled';
  async function available() {
    if (!configuration.enabled || Platform.OS === 'web' || !await SecureStore.isAvailableAsync()) {
      throw new Error('Secure storage is unavailable');
    }
  }
  return {
    async read() { await available(); return SecureStore.getItemAsync(key); },
    async write(value) {
      await available();
      if (value === null) await SecureStore.deleteItemAsync(key);
      else await SecureStore.setItemAsync(key, value);
    },
  };
}

type AuthContextValue = { config: AuthConfig; state: AuthState; controller: AuthController };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const controller = useMemo(() => new AuthController(createAuthApi(config), nativeStorage(config), config.enabled), []);
  const [state, setState] = useState<AuthState>(controller.getState());
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.restore();
    return unsubscribe;
  }, [controller]);
  return <AuthContext.Provider value={{ config, state, controller }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth requires AuthProvider');
  return context;
}
